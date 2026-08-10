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
 * Each fake window has a local store copy, and writes propagate after `carry`. Delays are compressed
 * but kept above Windows timer resolution when slot order is under test.
 */
function profile(carry = 0, compression = 20): { window: (id?: string) => ReadCoordinator } {
  const canonical = new Map<string, unknown>();
  const views: Map<string, unknown>[] = [];
  return {
    window: (id?: string) => {
      const own = new Map<string, unknown>(canonical);
      views.push(own);
      const store: SharedStore = {
        get: (key) => own.get(key),
        update: (key, value) => {
          const stored = JSON.parse(JSON.stringify(value)) as unknown;
          canonical.set(key, stored);
          own.set(key, stored);
          // Concurrent writers may finish with each other's value, matching non-atomic shared state.
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
      return new ReadCoordinator(new SharedUsageState(store), (ms) => delay(ms / compression), id);
    },
  };
}

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
 * Fixed ids select deterministic claim slots; `a` through `f` are distinct and `g` collides with `a`.
 */
test("a simultaneous arrival spends one request, not one each", async () => {
  const { window } = profile(16, 5);
  const open = ["a", "b", "c", "d", "e", "f"].map(window);

  const won = await Promise.all(open.map((each) => each.wins("claude")));

  expect(won.filter(Boolean)).toHaveLength(1);
});

test("windows that share a slot settle it between them, however many there are", async () => {
  const { window } = profile(4);
  const open = ["a", "g", "m"].map(window);

  const won = await Promise.all(open.map((each) => each.wins("claude")));

  expect(won.filter(Boolean)).toHaveLength(1);
});

test("a claim that lost the race does not cost the window that won its reading", async () => {
  const { window } = profile(60);
  const open = ["a", "b", "c", "f"].map(window);

  const won = await Promise.all(open.map((each) => each.wins("codex")));
  const readers = open.filter((_, index) => won[index]);
  await delay(150);
  await Promise.all(readers.map((each) => each.publish("codex", view, null)));
  await delay(150);

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

  expect(other.overdue(aged(gone, "claude", 0), 3_600)).toBe(false);
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
  await reader.publish("claude", view, new Date(Date.now() + 10_000));

  expect(reader.overdue(aged(reader, "claude", 12_000), 300)).toBe(false);
  expect(reader.overdue(aged(reader, "claude", FLOOR_MS + 500), 300)).toBe(true);
  expect(other.tooSoon(aged(reader, "claude", FLOOR_MS + 500))).toBe(true);
});

test("a refresh the user asked for still says that it read", async () => {
  const { window } = profile();
  const asked = window();
  const other = window();
  await asked.take("claude");

  expect(other.tooSoon(other.latest("claude"))).toBe(true);
});

test("a read that outlived its claim writes nothing over the window that took it", async () => {
  const { window } = profile();
  const slow = window();
  const asked = window();
  await slow.wins("claude");
  await asked.take("claude");
  await asked.publish("claude", { snapshot: null, message: "newer" }, null);

  await slow.publish("claude", { snapshot: null, message: "older" }, null);
  expect(asked.latest("claude")?.view.message).toBe("newer");

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
