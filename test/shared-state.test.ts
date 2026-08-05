import { expect, test } from "vitest";
import { SharedUsageState, type SharedEntry, type SharedStore } from "../src/shared-state";
import { MAX_RETRY_WAIT_MS, type UsageSnapshot } from "../src/usage";

/**
 * Values cross through JSON the way the real state store keeps them, which is the point of the
 * module under test: a `Date` written here comes back as something else entirely.
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
    // One window with a stated length and one without, which is what the two providers between
    // them actually publish: Codex says how long its windows run and Claude never does.
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
  // Live and inside the cap, which is the only kind of wait that changes what another window does.
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
  // A lease with no readable timestamp is no lease: reading is better than deferring to nothing.
  expect(
    new SharedUsageState(memento({ "sharedUsage.v1.claude": { owner: "abc" } })).read("claude"),
  ).toBeNull();
  // The entry stands on its own even when the reading inside it does not.
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

  // Nothing this version writes can look like this; a window of another version is the case. Kept
  // as a wait it would be renewed out of the entry for as long as the entry stands, by every window
  // at once, so the provider would never be read again.
  expect(entry(readAt + MAX_RETRY_WAIT_MS + 60_000)?.retryAt).toBeNull();
  // The rest of the entry survives it, as with any other unreadable field.
  expect(entry(readAt + MAX_RETRY_WAIT_MS + 60_000)?.readAt).toBe(readAt);
  expect(entry(readAt + 30_000)?.retryAt).toEqual(new Date(readAt + 30_000));
});

test("a window on the other version of the shape is not read at all", () => {
  const stored = { "sharedUsage.v2.claude": { readAt: Date.now(), owner: "abc" } };
  expect(new SharedUsageState(memento(stored)).read("claude")).toBeNull();
});

/**
 * The shape `v1` names, written out rather than round-tripped, because a round trip through this
 * file's own two halves agrees with itself however either half is renamed. What the key promises is
 * that two windows reading it are reading the same thing, and the windows on the other side of an
 * update run a build this one cannot call.
 *
 * So this is the test that fails when the wire format moves. It is not asking to be kept passing:
 * a field renamed or a unit changed here is a `v1` two builds no longer agree on, and the fix is
 * either to put it back or to bump the prefix — which parts the two shapes instead of letting the
 * older build read the newer one wrong.
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

/** And the same shape written back out, so the promise holds in the direction this window writes. */
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
      // Dates cross as epoch milliseconds, which is the one unit here that a `Date` would not
      // survive the round trip as.
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
