import { expect, test } from "vitest";
import { formatPace, paceFor, type Pace } from "../src/pace";
import type { UsageWindow } from "../src/usage";

/**
 * The pace is the one line on the tooltip that is not a measurement, so most of what is checked
 * here is when it declines to say anything: a rate taken off six minutes and one whole percent is
 * arithmetic, not a forecast, and a forecast that is wrong once is a line nobody reads again.
 */

/**
 * When the reading was taken, which is what every case here is measured from. Any moment would do:
 * what matters is that it is a fixed one, since `paceFor` takes it rather than reading a clock.
 */
const asOf = new Date("2026-08-01T12:00:00Z");

/** A window that opened `elapsed` minutes before the reading, expressed the way a provider states
 *  it — as the moment it refills — so the arithmetic under test is the arithmetic in the file. */
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

/** Times are drawn in the reader's own locale, so the tests state the moment rather than its text. */
function moment(at: Date): string {
  return at.toISOString();
}

function spoken(pace: Pace | null): string | null {
  return pace ? formatPace(pace, moment) : null;
}

test("a session window that will run dry says when", () => {
  // A fifth of the window gone and a fifth spent puts the limit exactly at the reset; half again
  // that rate puts it halfway there.
  const pace = paceFor(window("session", 30, 60), asOf);

  expect(pace).toEqual({ kind: "exhausted", at: new Date("2026-08-01T14:20:00Z") });
  // Hedged three times over — the clause, the verb, and the `~` — because the moment it shares a
  // row with is measured, and nothing but the words tells the two apart.
  expect(spoken(pace)).toBe("At this pace, runs out ~2026-08-01T14:20:00.000Z");
});

test("a session window that will not says where it lands instead", () => {
  const pace = paceFor(window("session", 12, 60), asOf);

  // A fifth of the window for twelve percent lands at sixty, which is the reassuring half of the
  // same division and costs nothing to state.
  expect(pace).toEqual({ kind: "landing", percent: 60 });
  expect(spoken(pace)).toBe("At this pace, ~60% by reset");
});

/** The two branches are one comparison apart, so the seam between them is where to look. */
test("the landing percentage is never above the hundred that would be an exhausted window", () => {
  // Dead on the reset: the rate reaches a hundred exactly as the window refills.
  expect(paceFor(window("session", 50, 150), asOf)).toEqual({ kind: "landing", percent: 100 });
  // The same spend in a minute less is a faster rate, and a faster rate crosses first.
  expect(paceFor(window("session", 50, 149), asOf)).toEqual({
    kind: "exhausted",
    at: new Date("2026-08-01T14:30:00Z"),
  });
  // A minute more is a slower one, which lands just under instead.
  expect(paceFor(window("session", 50, 151), asOf)).toEqual({ kind: "landing", percent: 99 });
});

test("the forecast is quantized, so an unchanged rate keeps redrawing the same line", () => {
  // Two readings a minute apart on the same rate would otherwise be two different strings, and a
  // tooltip that changes is a hover the workbench closes.
  const early = paceFor(window("session", 30, 60), asOf);
  const later = paceFor(window("session", 30.4, 61), asOf);

  expect(spoken(early)).toBe(spoken(later));
});

test("a weekly window is never forecast, only clocked", () => {
  // Three days into the week at fifty percent is the case a forecast would call a limit blown by
  // Thursday, for someone who works five days and finishes at seventy.
  const pace = paceFor(window("weekly", 50, 3 * 24 * 60), asOf);

  expect(pace).toEqual({ kind: "elapsed", percent: 43 });
  expect(spoken(pace)).toBe("43% of the week gone");
});

test("a rate taken off too little says nothing at all", () => {
  // Too early for the percentage to be a rate: whole percentages six minutes in read as tens of
  // points an hour.
  expect(paceFor(window("session", 1, 6), asOf)).toBeNull();
  // Long enough, but there is nothing yet to extend.
  expect(paceFor(window("session", 2, 90), asOf)).toBeNull();
  // The first minute of a week is not a week gone.
  expect(paceFor(window("weekly", 0, 30), asOf)).toBeNull();
});

test("a window with nothing to measure against is not paced", () => {
  // No stated reset, so the moment the window opened is unknown and so is everything after it.
  expect(paceFor({ kind: "session", usedPercent: 40, resetsAt: null }, asOf)).toBeNull();
  // Already full: there is no forecast left to make.
  expect(paceFor(window("session", 100, 60), asOf)).toBeNull();
  // A reading from beyond the window it describes, and one from before that window opened.
  expect(paceFor(window("session", 40, 301), asOf)).toBeNull();
  expect(paceFor(window("session", 40, -20), asOf)).toBeNull();
});

/**
 * Codex states how long its windows run and Claude does not, so the fallback is what every Claude
 * reading is paced by. A window opened at the wrong moment is a pace stated confidently and wrong.
 */
test("a stated window length is used over the one the kind implies", () => {
  // Sixty minutes into a stated four-hour window at twenty percent: five hours' worth by the
  // fallback, four by what the provider actually said.
  expect(paceFor(window("session", 20, 60, 240), asOf)).toEqual({ kind: "landing", percent: 80 });
  expect(paceFor(window("session", 20, 60), asOf)).toEqual({ kind: "landing", percent: 100 });
});
