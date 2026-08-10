import { expect, test } from "vitest";
import { SharedUsageState, type SharedEntry, type SharedStore } from "../src/shared-state";
import { MAX_RETRY_WAIT_MS, type UsageSnapshot } from "../src/usage";

/**
 * The fake store round-trips JSON so dates cross the same boundary as real global state.
 */
function memento(seed: Record<string, unknown> = {}): SharedStore {
  const store = new Map(Object.entries(seed));
  return {
    get: (key) => store.get(key),
    update: (key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    },
  };
}

const snapshot: UsageSnapshot = {
  windows: [
    {
      kind: "session",
      usedPercent: 12.4,
      resetsAt: new Date("2026-08-01T13:12:00Z"),
      windowMinutes: 300,
    },
    { kind: "weekly", usedPercent: 41, resetsAt: null, windowMinutes: null },
  ],
  plan: "plus",
  blocked: null,
  credits: "3 reset credits",
  fetchedAt: new Date("2026-08-01T10:00:00Z"),
  source: "claude-account-api",
};

test("a published reading survives the round trip through storage", async () => {
  const shared = new SharedUsageState(memento());
  await shared.publish("claude", {
    owner: "abc",
    view: { snapshot, message: null },
    retryAt: null,
  });

  const entry = shared.read("claude");
  expect(entry?.owner).toBe("abc");
  expect(entry?.view.snapshot).toEqual(snapshot);
  expect(entry?.view.snapshot?.fetchedAt).toBeInstanceOf(Date);
});

test("a claim stamps the lease without discarding the reading it already holds", async () => {
  const shared = new SharedUsageState(memento());
  await shared.publish("codex", { owner: "abc", view: { snapshot, message: null }, retryAt: null });
  await shared.claim("codex", "xyz");

  const entry = shared.read("codex");
  expect(entry?.owner).toBe("xyz");
  expect(entry?.view.snapshot).toEqual(snapshot);
  expect(Date.now() - (entry?.readAt ?? 0)).toBeLessThan(1_000);
});

test("publishing keeps the lease the claim stamped, so a slow read holds others off", async () => {
  const shared = new SharedUsageState(memento());
  await shared.claim("claude", "abc");
  const claimed = shared.read("claude")?.readAt;
  await shared.publish("claude", {
    owner: "abc",
    view: { snapshot, message: null },
    retryAt: null,
  });

  expect(shared.read("claude")?.readAt).toBe(claimed);
});

test("a result with no reading in it is still news the other windows must hear", async () => {
  const shared = new SharedUsageState(memento());
  await shared.publish("claude", {
    owner: "abc",
    view: { snapshot, message: null },
    retryAt: null,
  });
  const first = shared.read("claude")?.publishedAt ?? 0;
  await shared.publish("claude", {
    owner: "abc",
    view: { snapshot: null, message: "No Claude Code sign-in was found" },
    retryAt: null,
  });

  const entry = shared.read("claude");
  expect(entry?.view.snapshot).toBeNull();
  expect(entry?.view.message).toBe("No Claude Code sign-in was found");
  expect(entry?.publishedAt).toBeGreaterThanOrEqual(first);
});

test("a claim is not a publication, so it never counts as something to adopt", async () => {
  const shared = new SharedUsageState(memento());
  await shared.publish("claude", {
    owner: "abc",
    view: { snapshot, message: null },
    retryAt: null,
  });
  const published = shared.read("claude")?.publishedAt;
  await shared.claim("claude", "xyz");

  expect(shared.read("claude")?.publishedAt).toBe(published);
});

test("a rate-limit wait crosses to the other windows", async () => {
  const shared = new SharedUsageState(memento());
  const retryAt = new Date(Date.now() + 30_000);
  await shared.publish("claude", {
    owner: "abc",
    view: { snapshot: null, message: "no" },
    retryAt,
  });

  expect(shared.read("claude")?.retryAt).toEqual(retryAt);
});

test("nothing a window of another version wrote is taken on trust", () => {
  expect(new SharedUsageState(memento({ "sharedUsage.v1.claude": 42 })).read("claude")).toBeNull();
  expect(
    new SharedUsageState(memento({ "sharedUsage.v1.claude": { owner: "abc" } })).read("claude"),
  ).toBeNull();
  const partial = new SharedUsageState(
    memento({ "sharedUsage.v1.claude": { readAt: 1, snapshot: { windows: "nope" } } }),
  ).read("claude");
  expect(partial?.readAt).toBe(1);
  expect(partial?.view.snapshot).toBeNull();
});

test("a wait reaching past anything this version would sit out is dropped, not honoured", () => {
  const readAt = Date.now();
  const entry = (retryAt: number): SharedEntry | null =>
    new SharedUsageState(memento({ "sharedUsage.v1.claude": { readAt, retryAt } })).read("claude");

  expect(entry(readAt + MAX_RETRY_WAIT_MS + 60_000)?.retryAt).toBeNull();
  expect(entry(readAt + MAX_RETRY_WAIT_MS + 60_000)?.readAt).toBe(readAt);
  expect(entry(readAt + 30_000)?.retryAt).toEqual(new Date(readAt + 30_000));
});

test("a window on the other version of the shape is not read at all", () => {
  const stored = { "sharedUsage.v2.claude": { readAt: Date.now(), owner: "abc" } };
  expect(new SharedUsageState(memento(stored)).read("claude")).toBeNull();
});

/**
 * This hand-written `v1` shape must fail when the wire format changes. Restore compatibility or bump
 * the key prefix instead of updating the fixture to make the test pass.
 */
test("a v1 entry written by another window reads back as the reading it names", () => {
  const stored = {
    "sharedUsage.v1.claude": {
      readAt: 1_754_000_000_000,
      publishedAt: 1_754_000_001_000,
      owner: "window-b",
      retryAt: null,
      message: null,
      snapshot: {
        windows: [
          { kind: "session", usedPercent: 12.5, resetsAt: 1_754_000_600_000, windowMinutes: 300 },
          { kind: "weekly", usedPercent: 41, resetsAt: 1_754_600_000_000, windowMinutes: null },
        ],
        plan: "pro",
        blocked: null,
        credits: "3 reset credits",
        fetchedAt: 1_754_000_000_500,
        source: "claude-account-api",
      },
    },
  };

  const entry = new SharedUsageState(memento(stored)).read("claude");

  expect(entry).toEqual({
    readAt: 1_754_000_000_000,
    publishedAt: 1_754_000_001_000,
    owner: "window-b",
    retryAt: null,
    view: {
      message: null,
      verbatim: false,
      snapshot: {
        windows: [
          {
            kind: "session",
            usedPercent: 12.5,
            resetsAt: new Date(1_754_000_600_000),
            windowMinutes: 300,
          },
          {
            kind: "weekly",
            usedPercent: 41,
            resetsAt: new Date(1_754_600_000_000),
            windowMinutes: null,
          },
        ],
        plan: "pro",
        blocked: null,
        credits: "3 reset credits",
        fetchedAt: new Date(1_754_000_000_500),
        source: "claude-account-api",
      },
    },
  });
});

test("what this window publishes is the shape v1 names", async () => {
  const store = new Map<string, unknown>();
  const shared = new SharedUsageState({
    get: (key) => store.get(key),
    update: (key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    },
  });

  await shared.publish("claude", {
    owner: "window-a",
    view: {
      snapshot: {
        windows: [
          {
            kind: "session",
            usedPercent: 12.5,
            resetsAt: new Date(1_754_000_600_000),
            windowMinutes: 300,
          },
        ],
        plan: "pro",
        blocked: null,
        credits: null,
        fetchedAt: new Date(1_754_000_000_500),
        source: "claude-account-api",
      },
      message: null,
    },
    retryAt: null,
  });

  expect(store.get("sharedUsage.v1.claude")).toMatchObject({
    owner: "window-a",
    retryAt: null,
    message: null,
    snapshot: {
      windows: [
        { kind: "session", usedPercent: 12.5, resetsAt: 1_754_000_600_000, windowMinutes: 300 },
      ],
      plan: "pro",
      blocked: null,
      credits: null,
      fetchedAt: 1_754_000_000_500,
      source: "claude-account-api",
    },
  });
});
