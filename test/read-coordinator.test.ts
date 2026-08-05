import { expect, test } from "vitest";
import { MIN_REFRESH_INTERVAL_SECONDS } from "../src/configuration";
import { ReadCoordinator } from "../src/read-coordinator";
import { SharedUsageState, type SharedEntry, type SharedStore } from "../src/shared-state";
import type { ProviderId } from "../src/usage";

const FLOOR_MS = MIN_REFRESH_INTERVAL_SECONDS * 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The store as the windows of a profile really see it. Each window reads its own copy and a write
 * reaches the others only once the storage service has carried it there, which is the gap every
 * rule below exists for. `carry` of zero is a store that is never caught mid-write, for the tests
 * that are about what an entry means rather than about who got to it first.
 *
 * `compression` divides every wait the coordinator takes, and is a dial rather than a constant
 * because a slot squeezed too far stops being a slot. Windows resolves a timer to about sixteen
 * milliseconds, so a stagger compressed under that arrives whenever the clock next ticks, and the
 * order the slots exist to impose is settled by rounding instead. A test that turns on the stagger
 * relaxes this and raises `carry` by the same factor, which leaves the two in the same proportion.
 */
function profile(carry = 0, compression = 20): { window: (id?: string) => ReadCoordinator } {
  const canonical = new Map<string, unknown>();
  const views: Map<string, unknown>[] = [];
  return {
    window: (id?: string) => {
      // A window that opens later starts from what is already stored, rather than from nothing.
      const own = new Map<string, unknown>(canonical);
      views.push(own);
      const store: SharedStore = {
        get: (key) => own.get(key),
        update: (key, value) => {
          const stored = JSON.parse(JSON.stringify(value)) as unknown;
          canonical.set(key, stored);
          own.set(key, stored);
          // Each window applies what reaches it, in the order it reaches it. Two windows writing at
          // the same moment therefore end up holding each other's value rather than agreeing on
          // one, which is why a claim cannot be a lock and why losing one has to be free.
          const deliver = () => {
            for (const view of views) {
              if (view !== own) {
                view.set(key, stored);
              }
            }
          };
          if (carry === 0) {
            deliver();
          } else {
            setTimeout(deliver, carry);
          }
          return Promise.resolve();
        },
      };
      // Waits are compressed rather than removed: the order of the slots is what is under test, and
      // running them at their stated length would put a second and a half in every race here.
      return new ReadCoordinator(new SharedUsageState(store), (ms) => delay(ms / compression), id);
    },
  };
}

/**
 * The stored entry with its lease moved, which is how a passage of time is stated here. A wait
 * moves with it: it was stated relative to the read, and the read is what is being aged.
 */
function aged(window: ReadCoordinator, provider: ProviderId, by: number): SharedEntry {
  const entry = window.latest(provider);
  if (!entry) {
    throw new Error(`nothing was stored for ${provider}`);
  }
  return {
    ...entry,
    readAt: entry.readAt - by,
    retryAt: entry.retryAt && new Date(entry.retryAt.getTime() - by),
  };
}

const view = { snapshot: null, message: "read" };

test("nothing stored is nothing to defer to", () => {
  const window = profile().window();
  expect(window.tooSoon(null)).toBe(false);
  expect(window.overdue(null, 300)).toBe(true);
});

/**
 * Ids are named rather than drawn, because the id picks the slot a window contests in: `a` to `f`
 * take one slot each, and `g` shares `a`'s. Drawing them would make what these tests are about —
 * the order the windows arrive in — a matter of luck.
 */
test("a simultaneous arrival spends one request, not one each", async () => {
  // Every window restored together comes due in the same instant, and the store takes a moment to
  // carry the first claim to the rest. Six windows finding the lease free at once is the case.
  // The one test here whose answer rests on the distance between two slots, so it is the one that
  // cannot afford to have that distance rounded away.
  const { window } = profile(16, 5);
  const open = ["a", "b", "c", "d", "e", "f"].map(window);

  const won = await Promise.all(open.map((each) => each.wins("claude")));

  expect(won.filter(Boolean)).toHaveLength(1);
});

test("windows that share a slot settle it between them, however many there are", async () => {
  // `a`, `g` and `m` hash alike, so none of them sees the others stand down and all three claim.
  // Two of them would settle it whichever way the rule ran; three is what tells the rule apart,
  // because every window but the last is holding a stamp later than its own.
  const { window } = profile(4);
  const open = ["a", "g", "m"].map(window);

  const won = await Promise.all(open.map((each) => each.wins("claude")));

  expect(won.filter(Boolean)).toHaveLength(1);
});

test("a claim that lost the race does not cost the window that won its reading", async () => {
  // Carried slower than a claim settles, which is the state every window is in while they are all
  // still starting: none of them can see the others stand down, so several claim in earnest.
  const { window } = profile(60);
  const open = ["a", "b", "c", "f"].map(window);

  const won = await Promise.all(open.map((each) => each.wins("codex")));
  const readers = open.filter((_, index) => won[index]);
  // The read itself takes a moment, and the stamps left by the windows that stood down land during
  // it. Publishing before they arrive is what made this look like it worked.
  await delay(150);
  await Promise.all(readers.map((each) => each.publish("codex", view, null)));
  await delay(150);

  // A reading published under a lease another window has since stamped is a reading dropped, and an
  // entry left looking like a read still in flight — which puts every window back on the floor.
  const entry = open[0]?.latest("codex");
  if (!entry) {
    throw new Error("nothing was stored for codex");
  }
  expect(entry.view.message).toBe("read");
  expect(entry.publishedAt).toBeGreaterThanOrEqual(entry.readAt);
});

test("the window that read last is let back in before the others are", async () => {
  const { window } = profile();
  const incumbent = window();
  const other = window();
  await incumbent.wins("claude");

  const insideFloor = aged(incumbent, "claude", FLOOR_MS - 500);
  const pastFloor = aged(incumbent, "claude", FLOOR_MS + 500);

  expect(incumbent.tooSoon(insideFloor)).toBe(true);
  expect(other.tooSoon(insideFloor)).toBe(true);
  // Past the floor the incumbent may go again while the others are still standing down, which is
  // the whole of what settles the reading on one window without anyone electing it.
  expect(incumbent.tooSoon(pastFloor)).toBe(false);
  expect(other.tooSoon(pastFloor)).toBe(true);
});

test("the interval is the machine's, so a stamp older than it is anyone's to take", async () => {
  const window = profile().window();
  await window.wins("codex");

  expect(window.overdue(aged(window, "codex", 0), 300)).toBe(false);
  expect(window.overdue(aged(window, "codex", 301_000), 300)).toBe(true);
});

test("a claim with nothing published after it is given the floor and no longer", async () => {
  const { window } = profile();
  const gone = window();
  const other = window();
  await gone.wins("claude");

  // The owner is still reading: the others wait, however long the configured interval is.
  expect(other.overdue(aged(gone, "claude", 0), 3_600)).toBe(false);
  // It never published. Waiting out an hour for a window that closed mid-read is the thing the
  // shared interval was supposed to prevent, so the claim expires with the floor instead.
  expect(other.overdue(aged(gone, "claude", FLOOR_MS + 500), 3_600)).toBe(true);
});

test("a published reading holds the others for the whole interval, not just the floor", async () => {
  const { window } = profile();
  const reader = window();
  const other = window();
  await reader.wins("codex");
  await reader.publish("codex", view, null);

  expect(other.overdue(aged(reader, "codex", FLOOR_MS + 500), 300)).toBe(false);
  expect(other.overdue(aged(reader, "codex", 301_000), 300)).toBe(true);
});

test("a wait that has run out is a read owed at the floor, not at the interval", async () => {
  const { window } = profile();
  const reader = window();
  const other = window();
  await reader.wins("claude");
  // Shorter than the floor, which is the case that matters: the wait is over before anyone may
  // read, so nothing marks the moment unless the expired wait itself does.
  await reader.publish("claude", view, new Date(Date.now() + 10_000));

  expect(reader.overdue(aged(reader, "claude", 12_000), 300)).toBe(false);
  // Five minutes of stale numbers bought by ten seconds of rate limiting is what this prevents.
  expect(reader.overdue(aged(reader, "claude", FLOOR_MS + 500), 300)).toBe(true);
  // Due, not ours: the window that read last still goes first, and the rest still contest.
  expect(other.tooSoon(aged(reader, "claude", FLOOR_MS + 500))).toBe(true);
});

test("a refresh the user asked for still says that it read", async () => {
  const { window } = profile();
  const asked = window();
  const other = window();
  await asked.take("claude");

  // Taking skips the contest but not the record: without the stamp the next window would read
  // again over the top of a reading a second old.
  expect(other.tooSoon(other.latest("claude"))).toBe(true);
});

test("a read that outlived its claim writes nothing over the window that took it", async () => {
  const { window } = profile();
  const slow = window();
  const asked = window();
  await slow.wins("claude");
  // A refresh the user asked for, in another window, over the top of a read still running.
  await asked.take("claude");
  await asked.publish("claude", { snapshot: null, message: "newer" }, null);

  await slow.publish("claude", { snapshot: null, message: "older" }, null);
  expect(asked.latest("claude")?.view.message).toBe("newer");

  // And the lease it hands back is not its own to hand back: rewinding it here would set every
  // window reading at once, over a read that another window has already done.
  await slow.abandon("claude");
  expect(asked.overdue(asked.latest("claude"), 300)).toBe(false);
});

test("a read that fell over leaves neither a lease nor a hole where the reading was", async () => {
  const { window } = profile();
  const reader = window();
  const other = window();
  await reader.wins("claude");
  await reader.publish("claude", view, null);
  await reader.abandon("claude");

  const entry = other.latest("claude");
  expect(other.overdue(entry, 300)).toBe(true);
  expect(other.tooSoon(entry)).toBe(false);
  expect(entry?.view.message).toBe("read");
});

test("a published reading is what the next window shows, whoever read it", async () => {
  const { window } = profile();
  const reader = window();
  await reader.wins("codex");
  await reader.publish("codex", view, null);

  expect(window().latest("codex")?.view.message).toBe("read");
});
