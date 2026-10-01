import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import { localDay, shiftDay, type DailyTotals, type HistoryScan } from "../src/history";
import { HistoryService } from "../src/history-service";
import { UsageHistoryState } from "../src/history-store";
import type { SharedStore } from "../src/shared-state";
import type { ProviderId } from "../src/usage";

/**
 * These run with Claude Code and Codex switched off and cover what is particular to Antigravity:
 * scans spaced ten minutes apart, and scans that could not read everything.
 */

const SETTINGS: ExtensionConfiguration = {
  displayMode: "compact",
  percentageMode: "used",
  locale: undefined,
  showPace: true,
  warningThreshold: 80,
  errorThreshold: 95,
  warnWhen: "threshold",
  codexEnabled: false,
  claudeEnabled: false,
  antigravityEnabled: true,
  codexLabel: "",
  claudeLabel: "",
  antigravityLabel: "",
  refreshIntervalSeconds: 300,
  showHistory: true,
  theme: "dark",
};

const MINUTE = 60_000;
const START_MS = 4_000;

function harness(settings: Partial<ExtensionConfiguration> = {}) {
  const values = new Map<string, unknown>();
  const store: SharedStore = {
    get: (key) => values.get(key),
    update: (key, value) => {
      values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    },
  };
  const published = new Map<ProviderId, DailyTotals | null>();
  let answer: () => Promise<HistoryScan> = () => Promise.resolve({ days: {}, last: null });
  let scans = 0;
  const scannedAt: number[] = [];
  const unused = (): Promise<HistoryScan> => Promise.resolve({ days: {}, last: null });
  const service = (): HistoryService =>
    new HistoryService(
      new UsageHistoryState(store),
      (provider, totals) => void published.set(provider, totals),
      () => ({ ...SETTINGS, ...settings }),
      {
        claude: unused,
        codex: unused,
        antigravity: (_since, stored) => {
          scans += 1;
          scannedAt.push(stored?.scannedAt ?? 0);
          return answer();
        },
      },
    );
  return {
    service,
    scans: (): number => scans,
    scannedAt: (): number[] => scannedAt,
    days: (): Record<string, number> | undefined => published.get("antigravity")?.days,
    published,
    answers: (scan: HistoryScan) => void (answer = () => Promise.resolve(scan)),
    fails: () => void (answer = () => Promise.reject(new Error("no hub"))),
  };
}

let today = "";
let yesterday = "";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0));
  today = localDay(new Date());
  yesterday = shiftDay(today, -1);
});

afterEach(() => {
  vi.useRealTimers();
});

test("an Antigravity day is stored and shown in tokens", async () => {
  const world = harness();
  world.answers({ days: { [today]: 355_882, [yesterday]: 120 }, last: null });
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);

  expect(world.published.get("antigravity")).toMatchObject({
    unit: "tokens",
    days: { [today]: 355_882, [yesterday]: 120 },
  });
  expect(world.published.get("claude")).toBeNull();
  expect(world.published.get("codex")).toBeNull();
  history.dispose();
});

test("activity inside the ten minutes waits for them to pass instead of being dropped", async () => {
  const world = harness();
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);
  expect(world.scans()).toBe(1);

  await vi.advanceTimersByTimeAsync(MINUTE);
  world.answers({ days: { [today]: 900 }, last: null });
  history.handleActivity("antigravity");
  history.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(8 * MINUTE);
  expect(world.scans()).toBe(1);

  await vi.advanceTimersByTimeAsync(2 * MINUTE);
  expect(world.scans()).toBe(2);
  expect(world.days()).toEqual({ [today]: 900 });

  // Nothing asked for a third scan, so none comes.
  await vi.advanceTimersByTimeAsync(60 * MINUTE);
  expect(world.scans()).toBe(2);
  history.dispose();
});

test("a scan that left a conversation unread keeps the higher figure and comes back for it", async () => {
  const world = harness();
  world.answers({ days: { [today]: 1_000 }, last: null });
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);

  world.answers({ days: { [today]: 400 }, last: null, pending: true });
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  history.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(0);
  expect(world.scans()).toBe(2);
  expect(world.days()).toEqual({ [today]: 1_000 });

  world.answers({ days: { [today]: 1_500 }, last: null });
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  expect(world.scans()).toBe(3);
  expect(world.days()).toEqual({ [today]: 1_500 });

  await vi.advanceTimersByTimeAsync(60 * MINUTE);
  expect(world.scans()).toBe(3);
  history.dispose();
});

test("a scan that read everything is the whole truth, even when a day came out lower", async () => {
  const world = harness();
  world.answers({ days: { [today]: 1_000 }, last: null });
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);

  world.answers({ days: { [today]: 400 }, last: null });
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  history.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(0);

  expect(world.days()).toEqual({ [today]: 400 });
  history.dispose();
});

test("a scan that fails leaves what was stored on screen", async () => {
  const world = harness();
  world.answers({ days: { [today]: 1_000 }, last: null });
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);

  world.fails();
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  history.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(0);

  expect(world.scans()).toBe(2);
  expect(world.days()).toEqual({ [today]: 1_000 });
  history.dispose();
});

test("a scan that found nothing written keeps the stored days and still counts as a scan", async () => {
  const world = harness();
  world.answers({ days: { [today]: 1_000, [yesterday]: 300 }, last: null });
  const first = world.service();
  first.start();
  await vi.advanceTimersByTimeAsync(START_MS);
  first.dispose();

  // Another window opens later and has read nothing itself.
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  world.answers({ days: {}, last: null, unchanged: true });
  const second = world.service();
  second.start();
  await vi.advanceTimersByTimeAsync(START_MS);

  expect(world.scans()).toBe(2);
  expect(world.days()).toEqual({ [today]: 1_000, [yesterday]: 300 });

  // The scan was recorded, so activity a minute later waits out the ten minutes.
  await vi.advanceTimersByTimeAsync(MINUTE);
  second.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(0);
  expect(world.scans()).toBe(2);
  second.dispose();
});

test("the scanner is told when the last stored scan began", async () => {
  const world = harness();
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);
  const began = Date.now();

  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  history.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(0);

  expect(world.scannedAt()).toEqual([0, began]);
  history.dispose();
});

test("a window that closes takes its pending repeat with it", async () => {
  const world = harness();
  world.answers({ days: {}, last: null, pending: true });
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);
  expect(world.scans()).toBe(1);

  history.dispose();
  await vi.advanceTimersByTimeAsync(60 * MINUTE);

  expect(world.scans()).toBe(1);
});

test("with the strip switched off, Antigravity is never scanned", async () => {
  const world = harness({ showHistory: false });
  const history = world.service();
  history.start();
  await vi.advanceTimersByTimeAsync(START_MS);
  history.handleActivity("antigravity");
  await vi.advanceTimersByTimeAsync(60 * MINUTE);

  expect(world.scans()).toBe(0);
  expect(world.published.get("antigravity")).toBeNull();
  history.dispose();
});
