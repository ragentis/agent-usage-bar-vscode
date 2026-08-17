import { DAY_PATTERN, type DailyTotals, type HistoryUnit, type UsageSample } from "./history";
import type { SharedStore } from "./shared-state";
import { isRecord, validUsedPercent, type ProviderId } from "./usage";

/**
 * Daily totals outlive the transcripts they came from: Claude Code deletes its own after
 * `cleanupPeriodDays`. The version lives in the key so an incompatible shape is ignored rather than
 * misread, on the same terms as `shared-state.ts`.
 */

const KEY_PREFIX = "usageHistory.v1.";

/** Bounds a stored value that another version, or a corrupted entry, may have grown. */
const MAX_ENTRIES = 400;

export interface StoredHistory extends DailyTotals {
  /** Start of the last scan that wrote its result; the floor the next one measures back from. */
  scannedAt: number;
  /** Start of the last scan begun, written or not; only holds other windows off for a while. */
  claimedAt: number;
  /** Newest sample of the last scan, so an idle stretch does not swallow the next reading. */
  last: UsageSample | null;
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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
  const at = millis(value.at);
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
        scannedAt: millis(value.scannedAt) ?? 0,
        claimedAt: millis(value.claimedAt) ?? 0,
        last: parseSample(value.last),
      };
}

export class UsageHistoryState {
  constructor(private readonly store: SharedStore) {}

  read(provider: ProviderId): StoredHistory | null {
    return parseHistory(this.store.get(`${KEY_PREFIX}${provider}`));
  }

  /**
   * Stamped before the scan rather than after, so windows opening together do not all repeat the
   * first full parse. A duplicated scan only wastes work, so no stronger claim is needed. The claim
   * leaves `scannedAt` alone: a scan that never writes its result must not move the floor the next
   * one measures back from, or the days between would be lost.
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
