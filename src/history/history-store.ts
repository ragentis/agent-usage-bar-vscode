import type { SharedStore } from "../core/shared-state";
import type { ProviderId } from "../usage";
import { isRecord, validMillis, validUsedPercent } from "../validation";
import { DAY_PATTERN, type DailyTotals, type HistoryUnit, type UsageSample } from "./history";

/**
 * Stored totals are kept after their transcripts are gone; Claude Code deletes its transcripts
 * after `cleanupPeriodDays`. The version is part of the key, as in `shared-state.ts`.
 */

const KEY_PREFIX = "usageHistory.v1.";

/** Bounds a stored value that another version, or a corrupted entry, may have grown. */
const MAX_ENTRIES = 400;

export interface StoredHistory extends DailyTotals {
  /** Start of the last scan that wrote its result. The next scan starts from here. */
  scannedAt: number;
  /** Start of the last scan begun, whether or not it wrote. Only delays other windows' scans. */
  claimedAt: number;
  /** Newest sample of the last scan: the baseline for the first reading after an idle period. */
  last: UsageSample | null;
}

function historyUnit(value: unknown): HistoryUnit | null {
  return value === "percent" || value === "tokens" ? value : null;
}

function parseDays(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const days: Record<string, number> = {};
  for (const [day, amount] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    if (
      DAY_PATTERN.test(day) &&
      typeof amount === "number" &&
      Number.isFinite(amount) &&
      amount > 0
    ) {
      days[day] = amount;
    }
  }
  return days;
}

function parseSample(value: unknown): UsageSample | null {
  if (!isRecord(value)) {
    return null;
  }
  const at = validMillis(value.at);
  const usedPercent = validUsedPercent(value.usedPercent);
  return at === null || usedPercent === null ? null : { at, usedPercent };
}

function parseHistory(value: unknown): StoredHistory | null {
  if (!isRecord(value)) {
    return null;
  }
  const unit = historyUnit(value.unit);
  return unit === null
    ? null
    : {
        unit,
        days: parseDays(value.days),
        scannedAt: validMillis(value.scannedAt) ?? 0,
        claimedAt: validMillis(value.claimedAt) ?? 0,
        last: parseSample(value.last),
      };
}

export class UsageHistoryState {
  constructor(private readonly store: SharedStore) {}

  read(provider: ProviderId): StoredHistory | null {
    return parseHistory(this.store.get(`${KEY_PREFIX}${provider}`));
  }

  /**
   * Written before the scan so windows opening together do not all run the first full scan. A
   * duplicate scan only wastes work, so no stronger lock is needed. `scannedAt` is not changed
   * here: if a scan never wrote its result, moving it would skip the days in between.
   */
  claim(provider: ProviderId, unit: HistoryUnit, at: number): PromiseLike<void> {
    const stored = this.read(provider);
    return this.write(provider, {
      unit,
      days: stored?.days ?? {},
      scannedAt: stored?.scannedAt ?? 0,
      claimedAt: at,
      last: stored?.last ?? null,
    });
  }

  write(provider: ProviderId, history: StoredHistory): PromiseLike<void> {
    return this.store.update(`${KEY_PREFIX}${provider}`, {
      unit: history.unit,
      days: history.days,
      scannedAt: history.scannedAt,
      claimedAt: history.claimedAt,
      last: history.last && { at: history.last.at, usedPercent: history.last.usedPercent },
    });
  }
}
