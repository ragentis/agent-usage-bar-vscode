/**
 * Daily totals are derived from provider transcripts rather than sampled over time, so every window
 * recomputes the same day to the same value and no coordination is needed. Units differ per provider
 * and are never mixed or compared.
 */

export type HistoryUnit = "percent" | "tokens";

export interface DailyTotals {
  unit: HistoryUnit;
  /** Local calendar day, `YYYY-MM-DD`, to the amount recorded for it. */
  days: Record<string, number>;
}

/** One reading of a provider's own used percentage, at the moment the transcript recorded it. */
export interface UsageSample {
  at: number;
  usedPercent: number;
}

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MAX_STORED_DAYS = 60;

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** Days are local: the question is which evening the work happened on, not which UTC date. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function shiftDay(day: string, delta: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return localDay(new Date(year, month - 1, date + delta));
}

export function dayStart(day: string): number {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

export function addDay(days: Record<string, number>, day: string, amount: number): void {
  days[day] = (days[day] ?? 0) + amount;
}

/** What one scan of a provider's transcripts produced. */
export interface HistoryScan {
  days: Record<string, number>;
  /** Newest sample seen, carried into the next scan; null for providers without a counter. */
  last: UsageSample | null;
}

/**
 * A rising percentage is spending; a fall is the window resetting and contributes nothing. Samples
 * from every file must be merged before diffing, because concurrent sessions each record the same
 * account-wide counter and diffing them separately would count one spend once per session.
 *
 * `seed` is the newest sample of the previous scan. It only applies when this scan begins after it,
 * which happens when the account was idle across the whole overlap; without it the first turn after
 * an idle stretch would have nothing to be measured against.
 */
export function scanFromSamples(
  samples: readonly UsageSample[],
  seed: UsageSample | null = null,
): HistoryScan {
  const sorted = samples.toSorted((left, right) => left.at - right.at);
  const first = sorted[0];
  const days: Record<string, number> = {};
  let previous = first && seed && seed.at < first.at ? seed.usedPercent : null;
  for (const sample of sorted) {
    if (previous !== null && sample.usedPercent > previous) {
      addDay(days, localDay(new Date(sample.at)), sample.usedPercent - previous);
    }
    previous = sample.usedPercent;
  }
  return { days, last: sorted.at(-1) ?? seed };
}

/**
 * Inside the scanned span the transcripts are the whole truth, because a file holding a day's
 * records cannot have been written before that day. Earlier days are kept from the store, which
 * outlives the transcripts: Claude Code deletes its own after `cleanupPeriodDays`.
 */
export function mergeDays(
  stored: Record<string, number>,
  scanned: Record<string, number>,
  from: string,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [day, value] of Object.entries(stored)) {
    if (day < from) {
      merged[day] = value;
    }
  }
  for (const [day, value] of Object.entries(scanned)) {
    if (day >= from) {
      merged[day] = value;
    }
  }
  return merged;
}

export function pruneDays(
  days: Record<string, number>,
  today: string,
  keep = MAX_STORED_DAYS,
): Record<string, number> {
  const oldest = shiftDay(today, -(keep - 1));
  const kept: Record<string, number> = {};
  for (const [day, value] of Object.entries(days)) {
    if (day >= oldest && day <= today && value > 0) {
      kept[day] = value;
    }
  }
  return kept;
}

/**
 * Steps of the ramp; a day with no activity is drawn at the empty step instead. A step is both a
 * shade and a bar height, and the font carries one glyph per step, so changing this means changing
 * `scripts/build-font.mjs` with it.
 */
export const HISTORY_LEVELS = 5;

/** Days the strip shows. Thirty glyphs come to the width of the usage bars; fewer fall short of it. */
export const HISTORY_DAYS = 30;

export interface HistoryDay {
  day: string;
  value: number;
  /** Zero for an idle day, otherwise 1 to `HISTORY_LEVELS` against the busiest day shown. */
  level: number;
}

export interface HistoryStrip {
  unit: HistoryUnit;
  days: HistoryDay[];
  busiest: HistoryDay;
}

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(HISTORY_LEVELS, Math.max(1, Math.ceil((value / max) * HISTORY_LEVELS)));
}

/**
 * The strip always spans the requested days, so its width does not move with how much history
 * happens to be on record. A day before the first record is drawn like an idle one; for Claude Code,
 * whose transcripts are deleted after `cleanupPeriodDays`, the oldest cells of a long span can stay
 * empty permanently. Nothing is drawn at all unless some day in view has activity, which keeps an
 * empty strip off the tooltip.
 */
export function historyStrip(
  totals: DailyTotals,
  span: number,
  today: string,
): HistoryStrip | null {
  if (span < 1) {
    return null;
  }
  const days: HistoryDay[] = [];
  for (let index = span - 1; index >= 0; index--) {
    const day = shiftDay(today, -index);
    days.push({ day, value: totals.days[day] ?? 0, level: 0 });
  }
  const [first] = days;
  const max = Math.max(...days.map((entry) => entry.value));
  if (!first || max <= 0) {
    return null;
  }
  let busiest = first;
  for (const entry of days) {
    entry.level = levelFor(entry.value, max);
    if (entry.value > busiest.value) {
      busiest = entry;
    }
  }
  return { unit: totals.unit, days, busiest };
}
