import { expect, test } from "vitest";
import {
  dayStart,
  historyStrip,
  HISTORY_LEVELS,
  localDay,
  mergeDays,
  pruneDays,
  scanFromSamples,
  shiftDay,
  type UsageSample,
} from "../src/history";
import { UsageHistoryState } from "../src/history-store";
import type { SharedStore } from "../src/shared-state";

/**
 * Daily totals are derived from a counter that only rises until it resets, so the aggregation is
 * pinned against resets, concurrent sessions, and the gaps between scans.
 */

function at(day: string, hour: number): number {
  return dayStart(day) + hour * 60 * 60_000;
}

function samples(...entries: [string, number, number][]): UsageSample[] {
  return entries.map(([day, hour, usedPercent]) => ({ at: at(day, hour), usedPercent }));
}

test("only a rise in the percentage is counted, and to the day it was seen", () => {
  const { days } = scanFromSamples(
    samples(["2026-08-10", 9, 10], ["2026-08-10", 18, 25], ["2026-08-11", 11, 30]),
  );
  expect(days).toEqual({ "2026-08-10": 15, "2026-08-11": 5 });
});

test("a reset ends the run instead of subtracting from the day", () => {
  const { days } = scanFromSamples(
    samples(
      ["2026-08-10", 9, 80],
      ["2026-08-10", 20, 95],
      ["2026-08-11", 8, 2],
      ["2026-08-11", 9, 6],
    ),
  );
  expect(days).toEqual({ "2026-08-10": 15, "2026-08-11": 4 });
});

/**
 * Concurrent sessions each record the same account-wide counter. Diffing them separately would count
 * one spend once per session, so the samples are merged before any difference is taken.
 */
test("two sessions reporting the same counter are not counted twice", () => {
  const first = samples(["2026-08-10", 9, 10], ["2026-08-10", 11, 30]);
  const second = samples(["2026-08-10", 10, 20], ["2026-08-10", 12, 40]);
  expect(scanFromSamples([...first, ...second]).days).toEqual({ "2026-08-10": 30 });
});

test("the first sample of a scan is measured against the previous scan's last one", () => {
  const seed: UsageSample = { at: at("2026-08-08", 20), usedPercent: 40 };
  expect(scanFromSamples(samples(["2026-08-11", 9, 46]), seed).days).toEqual({
    "2026-08-11": 6,
  });
});

/** A seed inside the scanned span is already represented by the samples themselves. */
test("a seed that is not older than the scan is ignored", () => {
  const seed: UsageSample = { at: at("2026-08-11", 12), usedPercent: 40 };
  expect(scanFromSamples(samples(["2026-08-11", 9, 46]), seed).days).toEqual({});
});

test("the newest sample is carried out of the scan", () => {
  const scan = scanFromSamples(samples(["2026-08-10", 9, 10], ["2026-08-11", 9, 20]));
  expect(scan.last).toEqual({ at: at("2026-08-11", 9), usedPercent: 20 });
});

test("a scan with nothing in it keeps the seed it was given", () => {
  const seed: UsageSample = { at: at("2026-08-08", 20), usedPercent: 40 };
  expect(scanFromSamples([], seed)).toEqual({ days: {}, last: seed });
});

/**
 * A file holding a day's records cannot have been written before that day, so inside the scanned
 * span the transcripts are complete. Earlier days survive only in the store.
 */
test("a scan replaces the days it covers and leaves earlier ones alone", () => {
  const stored = { "2026-08-01": 12, "2026-08-09": 3, "2026-08-10": 4 };
  const scanned = { "2026-08-09": 99, "2026-08-10": 8, "2026-08-11": 6 };
  expect(mergeDays(stored, scanned, "2026-08-10")).toEqual({
    "2026-08-01": 12,
    "2026-08-09": 3,
    "2026-08-10": 8,
    "2026-08-11": 6,
  });
});

test("pruning drops days outside the kept span and days with nothing in them", () => {
  const days = { "2026-06-01": 5, "2026-08-09": 4, "2026-08-10": 0, "2026-08-30": 9 };
  expect(pruneDays(days, "2026-08-10", 7)).toEqual({ "2026-08-09": 4 });
});

test("days are local, so an evening stays on its own date", () => {
  const evening = new Date(2026, 7, 10, 23, 30);
  expect(localDay(evening)).toBe("2026-08-10");
  expect(shiftDay("2026-08-10", 1)).toBe("2026-08-11");
  expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
});

test("the strip runs to today and fills the days between with zeros", () => {
  const strip = historyStrip(
    { unit: "percent", days: { "2026-08-08": 20, "2026-08-10": 5 } },
    3,
    "2026-08-10",
  );
  expect(strip?.days.map((day) => day.day)).toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  // Twenty is the busiest day and takes the top step; five of it is a quarter, so it rounds to two.
  expect(strip?.days.map((day) => day.level)).toEqual([HISTORY_LEVELS, 0, 2]);
  expect(strip?.busiest).toMatchObject({ day: "2026-08-08", value: 20 });
});

/** The width must not move with how much history happens to be on record. */
test("the strip spans the requested days however little is recorded", () => {
  const strip = historyStrip({ unit: "tokens", days: { "2026-08-09": 1 } }, 30, "2026-08-10");
  expect(strip?.days).toHaveLength(30);
  expect(strip?.days[0]?.day).toBe("2026-07-12");
  expect(strip?.days.at(-1)?.day).toBe("2026-08-10");
});

test("the strip is capped at the requested span", () => {
  const days: Record<string, number> = {};
  for (let index = 0; index < 40; index++) {
    days[shiftDay("2026-08-10", -index)] = 1;
  }
  expect(historyStrip({ unit: "percent", days }, 7, "2026-08-10")?.days).toHaveLength(7);
});

test("a span with no activity in it draws no strip at all", () => {
  expect(historyStrip({ unit: "percent", days: {} }, 30, "2026-08-10")).toBeNull();
  // Recorded, but all of it older than the span in view.
  expect(historyStrip({ unit: "percent", days: { "2026-06-01": 9 } }, 30, "2026-08-10")).toBeNull();
});

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

test("stored history survives the round trip through storage", async () => {
  const state = new UsageHistoryState(memento());
  const last = { at: at("2026-08-10", 9), usedPercent: 42 };
  await state.write("codex", {
    unit: "percent",
    days: { "2026-08-10": 12.5 },
    scannedAt: 1_000,
    claimedAt: 1_000,
    last,
  });
  expect(state.read("codex")).toEqual({
    unit: "percent",
    days: { "2026-08-10": 12.5 },
    scannedAt: 1_000,
    claimedAt: 1_000,
    last,
  });
});

/**
 * A claim holds other windows off; it is not a result. The floor the next scan measures back from
 * moves only when a scan writes, or a scan that dies with its window would lose the days between.
 */
test("a claim stamps itself without moving the last scan or discarding what is stored", async () => {
  const state = new UsageHistoryState(memento());
  await state.write("claude", {
    unit: "tokens",
    days: { "2026-08-10": 5 },
    scannedAt: 1,
    claimedAt: 1,
    last: null,
  });
  await state.claim("claude", "tokens", 2_000);
  expect(state.read("claude")).toEqual({
    unit: "tokens",
    days: { "2026-08-10": 5 },
    scannedAt: 1,
    claimedAt: 2_000,
    last: null,
  });
});

test("values another version could have written are rejected rather than misread", () => {
  const state = new UsageHistoryState(
    memento({
      "usageHistory.v1.codex": {
        unit: "percent",
        days: { "2026-08-10": 4, yesterday: 9, "2026-08-11": -2, "2026-08-12": "8" },
        scannedAt: -1,
        last: { at: 0, usedPercent: 900 },
      },
      "usageHistory.v1.claude": { unit: "minutes", days: {} },
    }),
  );
  expect(state.read("codex")).toEqual({
    unit: "percent",
    days: { "2026-08-10": 4 },
    scannedAt: 0,
    claimedAt: 0,
    last: null,
  });
  expect(state.read("claude")).toBeNull();
});
