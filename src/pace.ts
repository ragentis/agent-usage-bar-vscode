import type { UsageWindow, WindowKind } from "./usage";

/**
 * Describes usage rate in addition to the current percentage. Session windows start with activity,
 * so their current rate can support a forecast. Weekly windows include inactive time such as nights
 * and weekends, so they report elapsed time without forecasting future usage.
 *
 * Calculations use the reading timestamp rather than the current time. This keeps elapsed time
 * aligned with the measured percentage and prevents tooltip text from changing between readings.
 */

/** Default lengths used when a provider, including Claude, omits the window duration. */
const WINDOW_MINUTES: Record<WindowKind, number> = { session: 300, weekly: 10_080 };

/**
 * Avoids unstable forecasts early in a window, when integer percentages exaggerate the rate.
 */
const MIN_ELAPSED_MINUTES = 15;

/** Ignores session usage too small for an integer percentage to support a useful forecast. */
const MIN_USED_PERCENT = 3;

/** Minimum elapsed share shown for a weekly window. */
const MIN_ELAPSED_PERCENT = 1;

/**
 * Rounds forecasts to keep consecutive readings at a stable rate on the same tooltip text. Five
 * minutes is below the useful precision of this extrapolation.
 */
const ROUND_TO_MINUTES = 5;

export type Pace =
  /** Forecast time at which usage reaches 100%. */
  | { kind: "exhausted"; at: Date }
  /** Forecast percentage at reset when usage remains below 100%. */
  | { kind: "landing"; percent: number }
  /** Elapsed share of a weekly window; this is not a usage forecast. */
  | { kind: "elapsed"; percent: number };

function roundedTo(moment: number, minutes: number): Date {
  const step = minutes * 60_000;
  return new Date(Math.round(moment / step) * step);
}

/** Returns null when the reading lacks a usable window start or enough data for a stable rate. */
export function paceFor(window: UsageWindow, asOf: Date): Pace | null {
  const { resetsAt, usedPercent } = window;
  if (!resetsAt) {
    return null;
  }
  const length = window.windowMinutes ?? WINDOW_MINUTES[window.kind];
  const openedAt = resetsAt.getTime() - length * 60_000;
  const elapsed = (asOf.getTime() - openedAt) / 60_000;
  // Reject readings outside the stated window, including stale readings from before a reset.
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
  // Project the current rate to the time at which usage reaches 100%.
  const full = openedAt + elapsed * (100 / usedPercent) * 60_000;
  return full < resetsAt.getTime()
    ? { kind: "exhausted", at: roundedTo(full, ROUND_TO_MINUTES) }
    : // This branch is reached only when exhaustion occurs at or after reset, so the result is at
      // most 100% without additional clamping.
      { kind: "landing", percent: Math.round(usedPercent * (length / elapsed)) };
}

/**
 * Formats pace within the space beside the reset time. Forecasts include "At this pace" and an
 * approximation marker to distinguish them from the measured weekly elapsed value.
 */
export function formatPace(pace: Pace, moment: (at: Date) => string): string {
  if (pace.kind === "exhausted") {
    return `At this pace, runs out ~${moment(pace.at)}`;
  }
  return pace.kind === "landing"
    ? `At this pace, ~${pace.percent}% by reset`
    : `${pace.percent}% of the week gone`;
}
