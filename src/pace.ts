import type { UsageWindow, WindowKind } from "./usage";

/**
 * What a window costs, read as a rate rather than as a total. The bar says where the account
 * stands; this says where it is heading.
 *
 * The two kinds are told apart deliberately, because the same arithmetic is honest for one and not
 * the other:
 *
 *   - A session window opens on the first message sent into it, so the time it has been open is
 *     time spent working. Extending that rate to the end of the window is a forecast worth
 *     stating to the minute.
 *   - A weekly window opens on a calendar anchor and runs through nights, weekends and days off,
 *     which the hours ahead of it hold in quite different measure. A strong Monday extrapolates to
 *     a limit blown by Thursday for someone who will finish the week at seventy percent. So
 *     nothing weekly is forecast: it states how much of the window has gone, beside a percentage
 *     the tooltip has already drawn, and leaves the reader to correct for their own week.
 *
 * Everything is measured from when the reading was taken rather than from now. That pairs the
 * elapsed time with the percentage it divides, and holds the line still between readings — which
 * is what makes it safe to draw on a hover, under the rule the reset moments are drawn by.
 */

/** The lengths the two kinds run when a provider states none, which is every Claude reading. */
const WINDOW_MINUTES: Record<WindowKind, number> = { session: 300, weekly: 10_080 };

/**
 * Under this the elapsed slice is too short for the percentage to be a rate. Percentages arrive
 * whole, so a single point of usage six minutes into a window reads as ten points an hour and
 * forecasts an exhausted limit that never comes.
 */
const MIN_ELAPSED_MINUTES = 15;

/** Under this there is nothing to extend: the rounding on the percentage is the whole reading. */
const MIN_USED_PERCENT = 3;

/** How much of a weekly window must have gone before saying so is worth a line. */
const MIN_ELAPSED_PERCENT = 1;

/**
 * The forecast is quantized to this before it is stated. Not for the accuracy — the error on an
 * extrapolation like this is measured in tens of minutes — but so that consecutive readings on an
 * unchanged rate keep landing on the same string, which is a hover that stays open.
 */
const ROUND_TO_MINUTES = 5;

export type Pace =
  /** The rate reaches the limit before the window refills, at about this moment. */
  | { kind: "exhausted"; at: Date }
  /** It does not, and this is where the window ends up instead. Never above a hundred. */
  | { kind: "landing"; percent: number }
  /** How much of a weekly window has gone. A statement about the clock, not about usage. */
  | { kind: "elapsed"; percent: number };

function roundedTo(moment: number, minutes: number): Date {
  const step = minutes * 60_000;
  return new Date(Math.round(moment / step) * step);
}

/**
 * `asOf` is when the reading was taken. Null wherever the numbers cannot carry a rate: no stated
 * reset and the window's own start is unknown, and too early or too little used and the rate is
 * rounding rather than work.
 */
export function paceFor(window: UsageWindow, asOf: Date): Pace | null {
  const { resetsAt, usedPercent } = window;
  if (!resetsAt) {
    return null;
  }
  const length = window.windowMinutes ?? WINDOW_MINUTES[window.kind];
  const openedAt = resetsAt.getTime() - length * 60_000;
  const elapsed = (asOf.getTime() - openedAt) / 60_000;
  // A reading from beyond the window it describes has been overtaken by a refill, and one from
  // before the window opened is a clock that disagrees with the service about what time it is.
  if (elapsed < MIN_ELAPSED_MINUTES || elapsed >= length) {
    return null;
  }
  if (window.kind === "weekly") {
    const percent = Math.round((elapsed / length) * 100);
    return percent >= MIN_ELAPSED_PERCENT ? { kind: "elapsed", percent } : null;
  }
  if (usedPercent < MIN_USED_PERCENT || usedPercent >= 100) {
    return null;
  }
  // Where the rate crosses a hundred, against where the window refills.
  const full = openedAt + elapsed * (100 / usedPercent) * 60_000;
  return full < resetsAt.getTime()
    ? { kind: "exhausted", at: roundedTo(full, ROUND_TO_MINUTES) }
    : // Landing past a hundred is exactly what crossing before the reset means, so this side is
      // always a hundred or under and needs no clamping.
      { kind: "landing", percent: Math.round(usedPercent * (length / elapsed)) };
}

/**
 * The line as it is read. It shares a row with the moment the window refills, which leaves about
 * twenty columns before the pair outgrows the bar and widens the tooltip around it.
 *
 * That budget goes on the hedge. The row sets a forecast beside a measurement in the same register,
 * and nothing but the words tells them apart. The elapsed line takes none, being the measured one.
 */
export function formatPace(pace: Pace, moment: (at: Date) => string): string {
  if (pace.kind === "exhausted") {
    return `At this pace, runs out ~${moment(pace.at)}`;
  }
  return pace.kind === "landing"
    ? `At this pace, ~${pace.percent}% by reset`
    : `${pace.percent}% of the week gone`;
}
