/**
 * Daily totals are derived from what the providers recorded, not sampled over time, so every window
 * computes the same value for a day. Units differ per provider and are never mixed or compared.
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

/** Days kept in the store. The first scan reaches equally far back. */
export const MAX_STORED_DAYS = 60;

/** Above any real message or call. Caps a malformed count so it cannot dominate the scale. */
const MAX_TOKENS = 5_000_000;

export function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, MAX_TOKENS);
}

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** Days use the local time zone, not UTC. */
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

export interface HistoryScan {
  days: Record<string, number>;
  /** Newest sample seen, carried into the next scan; null for providers without a counter. */
  last: UsageSample | null;
  /** Some record could not be read yet: the days are a lower bound and the scan is repeated. */
  pending?: boolean;
  /** Nothing was written since the last scan, so nothing was read and the stored days stand. */
  unchanged?: boolean;
}

/**
 * A rise in percentage is usage; a fall is a window reset and adds nothing. Samples from all files
 * are merged before diffing, because concurrent sessions record the same account-wide counter and
 * separate diffs would count one rise once per session.
 *
 * `seed` is the newest sample of the previous scan. It is used only when this scan's first sample
 * is later, so the first rise after an idle period has a baseline.
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
 * Scanned values replace stored ones from `from` onward: a file holding a day's records cannot have
 * been last written before that day, so the scan is complete for that span. Earlier days are kept
 * from the store, because Claude Code deletes its transcripts after `cleanupPeriodDays`.
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

/**
 * A day's total only grows, so after an incomplete scan the higher of the stored and scanned values
 * is kept.
 */
export function keepHigher(
  days: Record<string, number>,
  stored: Record<string, number>,
): Record<string, number> {
  const kept = { ...days };
  for (const [day, value] of Object.entries(stored)) {
    kept[day] = Math.max(kept[day] ?? 0, value);
  }
  return kept;
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
 * Number of activity levels; an idle day uses a separate empty level. Each level has its own glyph
 * in the icon font, so change `scripts/build-font.mjs` together with this.
 */
export const HISTORY_LEVELS = 5;

/** Days shown in the strip. Thirty glyphs match the width of the usage bars. */
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
 * The strip always spans the requested days, so its width is constant. A day before the first
 * record is drawn as idle. Returns null when no day in the span has activity, so no empty strip is
 * shown.
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
