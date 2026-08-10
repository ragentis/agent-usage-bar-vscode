import { expect, test } from "vitest";
import { formatPace, paceFor, type Pace } from "../src/pace";
import type { UsageWindow } from "../src/usage";

/**
 * Forecast tests emphasize cases where sparse integer data should produce no claim at all.
 */

const asOf = new Date("2026-08-01T12:00:00Z");

function window(
  kind: "session" | "weekly",
  usedPercent: number,
  elapsedMinutes: number,
  windowMinutes?: number,
): UsageWindow {
  const length = windowMinutes ?? (kind === "session" ? 300 : 10_080);
  return {
    kind,
    usedPercent,
    resetsAt: new Date(asOf.getTime() + (length - elapsedMinutes) * 60_000),
    windowMinutes,
  };
}

function moment(at: Date): string {
  return at.toISOString();
}

function spoken(pace: Pace | null): string | null {
  return pace ? formatPace(pace, moment) : null;
}

test("a session window that will run dry says when", () => {
  const pace = paceFor(window("session", 30, 60), asOf);

  expect(pace).toEqual({ kind: "exhausted", at: new Date("2026-08-01T14:20:00Z") });
  expect(spoken(pace)).toBe("At this pace, runs out ~2026-08-01T14:20:00.000Z");
});

test("a session window that will not says where it lands instead", () => {
  const pace = paceFor(window("session", 12, 60), asOf);

  expect(pace).toEqual({ kind: "landing", percent: 60 });
  expect(spoken(pace)).toBe("At this pace, ~60% by reset");
});

test("the landing percentage is never above the hundred that would be an exhausted window", () => {
  expect(paceFor(window("session", 50, 150), asOf)).toEqual({ kind: "landing", percent: 100 });
  expect(paceFor(window("session", 50, 149), asOf)).toEqual({
    kind: "exhausted",
    at: new Date("2026-08-01T14:30:00Z"),
  });
  expect(paceFor(window("session", 50, 151), asOf)).toEqual({ kind: "landing", percent: 99 });
});

test("the forecast is quantized, so an unchanged rate keeps redrawing the same line", () => {
  const early = paceFor(window("session", 30, 60), asOf);
  const later = paceFor(window("session", 30.4, 61), asOf);

  expect(spoken(early)).toBe(spoken(later));
});

test("a weekly window is never forecast, only clocked", () => {
  const pace = paceFor(window("weekly", 50, 3 * 24 * 60), asOf);

  expect(pace).toEqual({ kind: "elapsed", percent: 43 });
  expect(spoken(pace)).toBe("43% of the week gone");
});

test("a rate taken off too little says nothing at all", () => {
  expect(paceFor(window("session", 1, 6), asOf)).toBeNull();
  expect(paceFor(window("session", 2, 90), asOf)).toBeNull();
  expect(paceFor(window("weekly", 0, 30), asOf)).toBeNull();
});

test("a window with nothing to measure against is not paced", () => {
  expect(paceFor({ kind: "session", usedPercent: 40, resetsAt: null }, asOf)).toBeNull();
  expect(paceFor(window("session", 100, 60), asOf)).toBeNull();
  expect(paceFor(window("session", 40, 301), asOf)).toBeNull();
  expect(paceFor(window("session", 40, -20), asOf)).toBeNull();
});

test("a stated window length is used over the one the kind implies", () => {
  expect(paceFor(window("session", 20, 60, 240), asOf)).toEqual({ kind: "landing", percent: 80 });
  expect(paceFor(window("session", 20, 60), asOf)).toEqual({ kind: "landing", percent: 100 });
});
