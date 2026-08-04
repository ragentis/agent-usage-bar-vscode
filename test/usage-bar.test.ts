import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import { ReadCoordinator } from "../src/read-coordinator";
import { SharedUsageState, type SharedStore } from "../src/shared-state";
import { UsageBar, type ProviderPort } from "../src/usage-bar";
import {
  MAX_RETRY_WAIT_MS,
  type ProviderId,
  type ProviderResult,
  type ProviderView,
  type UsageSnapshot,
} from "../src/usage";

/**
 * `UsageBar` is the one place the rules meet, and it is also the place none of them can be read off
 * the code with confidence: a hold, a lease, a toggle, and a teardown all reach for the same state.
 * Nothing here touches vscode, the filesystem, or a child process — the class takes its providers
 * as ports, so a test supplies its own and drives the clock.
 */

const TICK_MS = 5_000;
const SETTINGS: ExtensionConfiguration = {
  displayMode: "compact",
  percentageMode: "used",
  warningThreshold: 80,
  errorThreshold: 95,
  codexEnabled: true,
  claudeEnabled: true,
  codexLabel: "",
  claudeLabel: "",
  refreshIntervalSeconds: 300,
};

const LOADING = "…loading";

function snapshot(usedPercent: number): UsageSnapshot {
  return {
    windows: [{ kind: "session", usedPercent, resetsAt: null }],
    plan: null,
    blocked: null,
    credits: null,
    fetchedAt: new Date(),
    source: "claude-account-api",
  };
}

function ok(usedPercent: number): ProviderResult {
  return { status: "ok", snapshot: snapshot(usedPercent) };
}

function refused(afterMs: number): ProviderResult {
  return { status: "unavailable", message: "rate limited", retryAt: refusedAt(afterMs) };
}

function refusedAt(afterMs: number): Date {
  return new Date(Date.now() + afterMs);
}

/** Lets whatever is queued run, without letting any timer come due. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** A read held open, so a teardown can happen while one is genuinely in flight. */
function deferred(): {
  promise: Promise<ProviderResult>;
  settle: (result: ProviderResult) => void;
} {
  let resolve: (result: ProviderResult) => void = () => {};
  const promise = new Promise<ProviderResult>((settle) => {
    resolve = settle;
  });
  return { promise, settle: (result) => resolve(result) };
}

/** One profile's worth of windows, sharing the state store the way VS Code shares it. */
function profile() {
  const values = new Map<string, unknown>();
  const store: SharedStore = {
    get: (key) => values.get(key),
    update: (key, value) => {
      values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    },
  };
  const shared = new SharedUsageState(store);
  // Settling instantly: which window wins a simultaneous claim is `read-coordinator`'s to prove.
  const coordinator = (): ReadCoordinator => new ReadCoordinator(shared, () => Promise.resolve());
  return {
    shared,
    coordinator,
    window: (options: WindowOptions = {}) => open(coordinator(), options),
  };
}

interface WindowOptions {
  providers?: ProviderId[];
  settings?: Partial<ExtensionConfiguration>;
}

/** One provider's port, with everything it was told to do written down beside it. */
function tracked(id: ProviderId) {
  let answer: () => Promise<ProviderResult> = () => Promise.resolve(ok(5));
  let watching: (() => void) | null = null;
  const painted: ProviderView[] = [];
  const counts = { read: 0, hidden: 0, disposed: 0, stopped: 0 };

  const port: ProviderPort = {
    id,
    display: {
      render: (view) => void painted.push(view),
      loading: () => void painted.push({ snapshot: null, message: LOADING }),
      hide: () => void (counts.hidden += 1),
      dispose: () => void (counts.disposed += 1),
    },
    read: () => {
      counts.read += 1;
      return answer();
    },
    watcher: {
      start: (onChange) => void (watching = onChange),
      stop: () => void (watching = null),
      dispose: () => void (watching = null),
    },
    isEnabled: (configuration) =>
      id === "claude" ? configuration.claudeEnabled : configuration.codexEnabled,
    stop: () => void (counts.stopped += 1),
  };

  return {
    port,
    counts,
    painted,
    last: (): ProviderView | undefined => painted.at(-1),
    answers: (next: () => Promise<ProviderResult>) => void (answer = next),
    /** As a transcript write reaches it, once the burst has settled. */
    agentRan: () => watching?.(),
  };
}

function open(reads: ReadCoordinator, { providers = ["claude"], settings = {} }: WindowOptions) {
  let current = { ...SETTINGS, ...settings };
  const tracking = providers.map(tracked);
  const first = tracking[0];
  if (!first) {
    throw new Error("a window with no providers is not a window");
  }
  const bar = new UsageBar(
    tracking.map(({ port }) => port),
    reads,
    () => current,
  );
  return {
    // Spread, so the single-provider tests read straight off the window and only the tests that
    // care about more than one have to say which.
    ...first,
    bar,
    of: (id: ProviderId) => {
      const found = tracking.find(({ port }) => port.id === id);
      if (!found) {
        throw new Error(`this window has no ${id}`);
      }
      return found;
    },
    /** As the settings UI reaches the extension: written first, announced second. */
    configure: (patch: Partial<ExtensionConfiguration>) => {
      current = { ...current, ...patch };
      bar.handleConfigurationChange();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a stated wait is honoured even by the refresh a user asked for", async () => {
  const window = profile().window();
  window.answers(() => Promise.resolve(refused(120_000)));
  await window.bar.refresh({ force: true });
  expect(window.counts.read).toBe(1);

  // Every trigger alike, and the loading spinner a manual refresh puts up is answered rather than
  // left spinning: the spinner goes up, and what the item ends on is the wait.
  await window.bar.refresh({ showLoading: true, force: true });
  window.agentRan();
  await flush();

  expect(window.counts.read).toBe(1);
  expect(window.painted.map((view) => view.message)).toContain(LOADING);
  // The provider said "rate limited"; what the item ends on says more than that, and only the wait
  // laid over the reading at draw time says it. It names the moment rather than counting down to
  // it, because a message that changed every tick would be a tooltip closing under a reader.
  expect(window.last()?.message).toMatch(/rate limiting requests; retrying at \S/);
});

test("a wait longer than any this version sits out neither spins nor stalls", async () => {
  const window = profile().window();
  window.answers(() => Promise.resolve(refused(30 * 24 * 60 * 60_000)));
  await window.bar.refresh({ force: true });
  expect(window.counts.read).toBe(1);

  window.bar.start();
  window.answers(() => Promise.resolve(ok(5)));
  const elapsedMs = MAX_RETRY_WAIT_MS / 2;
  await vi.advanceTimersByTimeAsync(elapsedMs);
  const intervals = elapsedMs / (SETTINGS.refreshIntervalSeconds * 1_000);

  // Uncapped, that wait is a `setTimeout` beyond its range: it fires at once instead of saying so
  // and is re-armed by the next adoption, which is a busy loop wearing a month-long wait. Dropped
  // rather than obeyed, the window simply goes back to its interval — and the next refusal it
  // meets states a wait it can actually keep. Both bounds are the point: one rules out the spin,
  // the other rules out a refusal that outlives every window that heard it.
  expect(window.counts.read).toBeGreaterThan(1);
  expect(window.counts.read).toBeLessThan(intervals * 3);
  expect(window.last()?.message).toBeNull();
});

test("a refusal shorter than the floor costs the floor, not the whole interval", async () => {
  const window = profile().window();
  window.answers(() => Promise.resolve(refused(10_000)));
  window.bar.start();
  await flush();
  expect(window.counts.read).toBe(1);

  window.answers(() => Promise.resolve(ok(7)));
  // The wait runs out inside the floor, so there is still nothing anyone may do about it.
  await vi.advanceTimersByTimeAsync(25_000);
  expect(window.counts.read).toBe(1);

  // But what is owed at the floor is the read, not the remainder of a five-minute interval: the
  // reading standing in for one here is the refusal, and the refusal is what has just expired.
  await vi.advanceTimersByTimeAsync(15_000);
  expect(window.counts.read).toBe(2);
  expect(window.last()?.snapshot?.windows[0]?.usedPercent).toBe(7);
  expect(window.last()?.message).toBeNull();
});

test("another window getting through ends the wait for the ones still holding it", async () => {
  const { shared, coordinator, window } = profile();
  const other = coordinator();
  await other.take("claude");
  await other.publish("claude", { snapshot: null, message: "rate limited" }, refusedAt(600_000));

  const held = window();
  held.bar.start();
  await flush();
  expect(held.counts.read).toBe(0);
  expect(held.last()?.message).toMatch(/rate limiting/);

  // The window that owns the lease gets through before the wait it published runs out. Separated
  // in time from the refusal, because a publication is recognized as news by the moment it was
  // written and the clock here does not move on its own.
  await vi.advanceTimersByTimeAsync(TICK_MS);
  await other.take("claude");
  await other.publish("claude", { snapshot: snapshot(11), message: null }, null);
  await vi.advanceTimersByTimeAsync(TICK_MS);

  // Without this the refusal outlives the service, and the item states a failure over fresh numbers.
  expect(held.last()?.message).toBeNull();
  expect(held.last()?.snapshot?.windows[0]?.usedPercent).toBe(11);
  expect(shared.read("claude")?.retryAt).toBeNull();
});

test("switching a provider off and back on clears the reading but never the wait", async () => {
  const window = profile().window();
  window.answers(() => Promise.resolve(refused(600_000)));
  await window.bar.refresh({ force: true });
  expect(window.counts.read).toBe(1);

  window.configure({ claudeEnabled: false });
  await flush();
  expect(window.counts.hidden).toBe(1);
  expect(window.counts.stopped).toBe(1);

  // A toggle is not a wait anyone waived, and coming back must not spend a request to say so.
  window.configure({ claudeEnabled: true });
  await flush();
  expect(window.counts.read).toBe(1);
  expect(window.last()?.message).toMatch(/rate limiting/);
});

test("a read answered by this window closing is never published as the account's", async () => {
  const { shared, window } = profile();
  const closing = window();
  const read = deferred();
  closing.answers(() => read.promise);

  const pending = closing.bar.refresh({ force: true });
  // Flushed, so the read is genuinely in flight rather than still queued behind the claim.
  await flush();
  closing.bar.dispose();
  // What a teardown hands back describes this window, not the account: the provider was stopped
  // from under its own read.
  read.settle({ status: "unavailable", message: "the provider was stopped" });
  await pending;

  expect(shared.read("claude")?.view.message).toBeNull();
  expect(closing.counts.disposed).toBe(1);
});

test("a read that fell over hands the lease straight back", async () => {
  const { coordinator, window } = profile();
  const failing = window();
  failing.answers(() => Promise.reject(new Error("the network is down")));

  await failing.bar.refresh({ force: true });

  // The interval was never spent, so no other window has reason to wait it out on our account.
  const other = coordinator();
  expect(other.overdue(other.latest("claude"), 300)).toBe(true);
  expect(other.tooSoon(other.latest("claude"))).toBe(false);
});

test("the providers are independent: a read for one is not a read for the other", async () => {
  const window = profile().window({ providers: ["claude", "codex"] });

  await window.bar.refresh({ only: "codex", force: true });
  expect(window.of("codex").counts.read).toBe(1);
  expect(window.of("claude").counts.read).toBe(0);

  // Each provider keeps its own lease, so spending one does not stand the other down.
  await window.bar.refresh({ only: "claude", force: true });
  expect(window.of("claude").counts.read).toBe(1);
  expect(window.of("codex").counts.read).toBe(1);

  // And switching one off leaves the other showing its numbers.
  window.configure({ codexEnabled: false });
  await flush();
  expect(window.of("codex").counts.hidden).toBe(1);
  expect(window.of("claude").counts.hidden).toBe(0);
  expect(window.of("claude").last()?.snapshot).not.toBeNull();
});

test("a provider this window has stopped reading for is not left running", async () => {
  // An hour between background reads, which is what a window that is not doing the reading looks
  // like from the inside: the other windows have the lease and this one only adopts.
  const window = profile().window({ settings: { refreshIntervalSeconds: 3_600 } });
  window.bar.start();
  await flush();
  expect(window.counts.read).toBe(1);
  expect(window.counts.stopped).toBe(0);

  // Ten minutes on, the process it started is only idling, and giving it up costs nothing: the
  // next read this window does starts a fresh one.
  await vi.advanceTimersByTimeAsync(11 * 60_000);

  expect(window.counts.read).toBe(1);
  expect(window.counts.stopped).toBe(1);
});

test("a reading another window took is shown rather than asked for again", async () => {
  const { coordinator, window } = profile();
  const other = coordinator();
  await other.take("claude");
  await other.publish("claude", { snapshot: snapshot(63), message: null }, null);

  const watching = window();
  watching.bar.start();
  await flush();

  expect(watching.counts.read).toBe(0);
  expect(watching.last()?.snapshot?.windows[0]?.usedPercent).toBe(63);
});
