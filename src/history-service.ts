import { scanClaudeHistory } from "./claude-history";
import { scanCodexHistory } from "./codex-history";
import type { ExtensionConfiguration } from "./configuration";
import {
  dayStart,
  localDay,
  mergeDays,
  pruneDays,
  shiftDay,
  type DailyTotals,
  type HistoryScan,
  type HistoryUnit,
} from "./history";
import type { StoredHistory, UsageHistoryState } from "./history-store";
import type { ProviderId } from "./usage";

const UNITS: Record<ProviderId, HistoryUnit> = { claude: "tokens", codex: "percent" };

const PROVIDERS = ["claude", "codex"] as const satisfies readonly ProviderId[];

const DAY_MS = 24 * 60 * 60_000;

/** How far back the first scan reaches. The store keeps the same span. */
const FIRST_SCAN_DAYS = 60;

/**
 * A later scan re-derives only the days that could still change, and reads one further day so the
 * first of them has yesterday's readings to be measured against.
 */
const RESCAN_BACK_MS = DAY_MS;

/** A scan this recent is treated as the current one, whichever window ran it. */
const SCAN_FRESH_MS = 2 * 60_000;

/** Activation belongs to the status bar reading; transcripts are parsed once it is on screen. */
const START_DELAY_MS = 4_000;

function isEnabled(provider: ProviderId, configuration: ExtensionConfiguration): boolean {
  const enabled = provider === "claude" ? configuration.claudeEnabled : configuration.codexEnabled;
  return enabled && configuration.showHistory;
}

/**
 * Daily history is derived from what the providers already wrote to disk, so every window computes
 * the same answer and none of the read coordination the live readings need applies here.
 */
export class HistoryService {
  private readonly running = new Map<ProviderId, Promise<void>>();
  private startTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly state: UsageHistoryState,
    private readonly publish: (provider: ProviderId, totals: DailyTotals | null) => void,
    private readonly readConfiguration: () => ExtensionConfiguration,
  ) {}

  start(): void {
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.refresh();
    }, START_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  /** Transcript writes are the only signal that a day's total has moved. */
  handleActivity(provider: ProviderId): void {
    void this.scan(provider);
  }

  handleConfigurationChange(): void {
    this.refresh();
  }

  private refresh(): void {
    for (const provider of PROVIDERS) {
      void this.scan(provider);
    }
  }

  private scan(provider: ProviderId): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!isEnabled(provider, this.readConfiguration())) {
      this.publish(provider, null);
      return Promise.resolve();
    }
    const pending = this.running.get(provider);
    if (pending) {
      return pending;
    }
    const run = this.derive(provider)
      .catch(() => {
        // History is best effort: a failed scan leaves whatever was already stored on screen.
      })
      .finally(() => this.running.delete(provider));
    this.running.set(provider, run);
    return run;
  }

  private async derive(provider: ProviderId): Promise<void> {
    const unit = UNITS[provider];
    const now = Date.now();
    const stored = this.current(provider, unit);
    if (stored && now - Math.max(stored.scannedAt, stored.claimedAt) < SCAN_FRESH_MS) {
      this.publish(provider, stored);
      return;
    }
    const today = localDay(new Date(now));
    const from = stored?.scannedAt
      ? localDay(new Date(Math.min(stored.scannedAt, now) - RESCAN_BACK_MS))
      : shiftDay(today, -(FIRST_SCAN_DAYS - 1));
    await this.state.claim(provider, unit, now);
    const scan = await this.read(provider, dayStart(shiftDay(from, -1)), stored);
    const next: StoredHistory = {
      unit,
      days: pruneDays(mergeDays(stored?.days ?? {}, scan.days, from), today),
      scannedAt: now,
      claimedAt: now,
      last: scan.last,
    };
    if (this.disposed) {
      return;
    }
    await this.state.write(provider, next);
    this.publish(provider, next);
  }

  /** A stored unit that no longer matches the provider is from another shape and cannot be merged. */
  private current(provider: ProviderId, unit: HistoryUnit): StoredHistory | null {
    const stored = this.state.read(provider);
    return stored && stored.unit === unit ? stored : null;
  }

  private read(
    provider: ProviderId,
    since: number,
    stored: StoredHistory | null,
  ): Promise<HistoryScan> {
    return provider === "codex"
      ? scanCodexHistory(since, stored?.last ?? null)
      : scanClaudeHistory(since);
  }
}
