import { expect, test } from "vitest";
import { mergeView, UnstartedWindows, type ProviderView, type UsageSnapshot } from "../src/usage";
import { validLabel } from "../src/validation";

const snapshot: UsageSnapshot = {
  windows: [{ kind: "session", usedPercent: 12, resetsAt: null }],
  plan: "plus",
  blocked: null,
  credits: null,
  fetchedAt: new Date("2026-08-01T10:00:00Z"),
  source: "claude-account-api",
};

const held: ProviderView = { snapshot, message: null };

test("a reading replaces what came before it, message and all", () => {
  const newer = { ...snapshot, fetchedAt: new Date("2026-08-01T10:05:00Z") };
  expect(
    mergeView({ snapshot, message: "stale complaint" }, { snapshot: newer, message: null }),
  ).toEqual({ snapshot: newer, message: null });
});

test("a message arriving without a reading never blanks the one on screen", () => {
  expect(mergeView(held, { snapshot: null, message: "could not be reached" })).toEqual({
    snapshot,
    message: "could not be reached",
  });
});

test("with nothing held, a message is all there is to show", () => {
  expect(mergeView(undefined, { snapshot: null, message: "no sign-in was found" })).toEqual({
    snapshot: null,
    message: "no sign-in was found",
  });
});

test("a label longer than a tooltip line can carry is not a label", () => {
  expect(validLabel("x".repeat(80))).toHaveLength(80);
  expect(validLabel("x".repeat(81))).toBeNull();
  expect(validLabel(`  ${"x".repeat(80)}  `)).toHaveLength(80);
});

test("only a string with something in it is a label", () => {
  expect(validLabel("  max  ")).toBe("max");
  expect(validLabel("")).toBeNull();
  expect(validLabel("   ")).toBeNull();
  expect(validLabel(null)).toBeNull();
  expect(validLabel(42)).toBeNull();
  expect(validLabel({ toString: () => "max" })).toBeNull();
});

const HOUR = 3_600_000;
const start = Date.parse("2026-10-03T10:00:00Z");

function readingAt(offsetMs: number, resetOffsetMs: number | null, usedPercent = 0): UsageSnapshot {
  return {
    ...snapshot,
    windows: [
      {
        kind: "session",
        usedPercent,
        resetsAt: resetOffsetMs === null ? null : new Date(start + resetOffsetMs),
        windowMinutes: 300,
      },
    ],
    fetchedAt: new Date(start + offsetMs),
  };
}

function resetAfter(...readings: UsageSnapshot[]): Date | null | undefined {
  const unstarted = new UnstartedWindows();
  return readings.map((reading) => unstarted.withoutRollingResets(reading)).at(-1)?.windows[0]
    ?.resetsAt;
}

test("a first reading dated a full window ahead has not started", () => {
  expect(resetAfter(readingAt(0, 5 * HOUR))).toBeNull();
  expect(resetAfter(readingAt(0, 5 * HOUR - 5_000))).toBeNull();
  expect(resetAfter(readingAt(0, 4 * HOUR))).not.toBeNull();
  expect(resetAfter(readingAt(0, 5 * HOUR, 1))).not.toBeNull();
});

test("a reset date that moves with each reading has not started", () => {
  expect(resetAfter(readingAt(0, 5 * HOUR), readingAt(60_000, 5 * HOUR + 60_000))).toBeNull();
  expect(resetAfter(readingAt(0, 5 * HOUR), readingAt(60_000, 5 * HOUR + 61_000))).toBeNull();
});

test("a reset date that stopped moving is shown, even at 0% and seconds after the start", () => {
  // The window started 40 seconds after the first reading, 20 seconds before the second.
  expect(
    resetAfter(readingAt(0, 5 * HOUR), readingAt(60_000, 5 * HOUR + 40_000))?.toISOString(),
  ).toBe("2026-10-03T15:00:40.000Z");
  expect(
    resetAfter(
      readingAt(0, 5 * HOUR),
      readingAt(60_000, 5 * HOUR + 40_000),
      readingAt(120_000, 5 * HOUR + 40_000),
    ),
  ).not.toBeNull();
});

test("a moving reset date is recognised when the local clock is wrong", () => {
  const fastClock = 10 * 60_000;
  expect(
    resetAfter(readingAt(fastClock, 5 * HOUR), readingAt(fastClock + 60_000, 5 * HOUR + 60_000)),
  ).toBeNull();
});

test("a date from a window that ended is not compared with the next window", () => {
  expect(resetAfter(readingAt(0, 30 * 60_000, 40), readingAt(HOUR, 6 * HOUR))).toBeNull();
  expect(resetAfter(readingAt(0, null), readingAt(HOUR, 6 * HOUR))).toBeNull();
});
