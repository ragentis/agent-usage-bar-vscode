import type { UsageWindow, WindowKind } from "./usage";

/**
 * Session windows start with activity and support a forecast. Weekly windows include inactive time,
 * so they report elapsed time only. Both use the reading timestamp to keep the calculation aligned
 * with its measured percentage.
 */

const WINDOW_MINUTES: Record<WindowKind, number> = { session: 300, weekly: 10_080 };

// Integer percentages produce unstable rates early in a window or at very low usage.
const MIN_ELAPSED_MINUTES = 15;

const MIN_USED_PERCENT = 3;

const MIN_ELAPSED_PERCENT = 1;

/**
 * Quantization keeps a stable rate on the same tooltip text; five minutes is below the useful
 * precision of the forecast.
 */
const ROUND_TO_MINUTES = 5;

export type Pace =
  | { kind: "exhausted"; at: Date }
  | { kind: "landing"; percent: number }
  | { kind: "elapsed"; percent: number };

function roundedTo(moment: number, minutes: number): Date {
  const step = minutes * 60_000;
  return new Date(Math.round(moment / step) * step);
}

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
  const full = openedAt + elapsed * (100 / usedPercent) * 60_000;
  return full < resetsAt.getTime()
    ? { kind: "exhausted", at: roundedTo(full, ROUND_TO_MINUTES) }
    : // This branch is reached only when exhaustion occurs at or after reset, so the result is at
      // most 100% without additional clamping.
      { kind: "landing", percent: Math.round(usedPercent * (length / elapsed)) };
}

/**
 * Forecast text is explicitly hedged so it cannot be mistaken for the measured reset time beside it.
 */
export function formatPace(pace: Pace, moment: (at: Date) => string): string {
  if (pace.kind === "exhausted") {
    return `At this pace, runs out ~${moment(pace.at)}`;
  }
  return pace.kind === "landing"
    ? `At this pace, ~${pace.percent}% by reset`
    : `${pace.percent}% of the week gone`;
}
