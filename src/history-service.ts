import { scanClaudeHistory } from "./claude-history";
import { scanCodexHistory } from "./codex-history";
import type { ExtensionConfiguration } from "./configuration";
import {
  dayStart,
  keepHigher,
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

const UNITS: Record<ProviderId, HistoryUnit> = {
  claude: "tokens",
  codex: "percent",
  antigravity: "tokens",
};

const PROVIDERS = ["claude", "codex", "antigravity"] as const satisfies readonly ProviderId[];

/** `scannedAt` is when the last stored scan began, or zero when there is none. */
export type ScanAntigravity = (since: number, scannedAt: number) => Promise<HistoryScan>;

const DAY_MS = 24 * 60 * 60_000;

/** How far back the first scan reaches. The store keeps the same span. */
const FIRST_SCAN_DAYS = 60;

/**
 * A later scan re-derives only the days that could still change, and reads one further day so the
 * first of them has yesterday's readings to be measured against.
 */
const RESCAN_BACK_MS = DAY_MS;

/**
 * A scan this recent is treated as the current one, whichever window ran it. An Antigravity scan
 * starts a process, so it is spaced further apart.
 */
const SCAN_FRESH_MS: Record<ProviderId, number> = {
  claude: 2 * 60_000,
  codex: 2 * 60_000,
  antigravity: 10 * 60_000,
};

/** Past the wait itself, so the repeated scan is not refused as too recent by a few milliseconds. */
const FOLLOW_UP_MARGIN_MS = 1_000;

/** Activation belongs to the status bar reading; transcripts are parsed once it is on screen. */
const START_DELAY_MS = 4_000;

function isEnabled(provider: ProviderId, configuration: ExtensionConfiguration): boolean {
  const enabled: Record<ProviderId, boolean> = {
    claude: configuration.claudeEnabled,
    codex: configuration.codexEnabled,
    antigravity: configuration.antigravityEnabled,
  };
  return enabled[provider] && configuration.showHistory;
}

/**
 * Daily history is derived from what the providers already wrote to disk, so every window computes
 * the same answer and none of the read coordination the live readings need applies here.
 */
export class HistoryService {
  private readonly running = new Map<ProviderId, Promise<void>>();
  private readonly followUps = new Map<ProviderId, NodeJS.Timeout>();
  private startTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly state: UsageHistoryState,
    private readonly publish: (provider: ProviderId, totals: DailyTotals | null) => void,
    private readonly readConfiguration: () => ExtensionConfiguration,
    private readonly scanAntigravity: ScanAntigravity,
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
    for (const timer of this.followUps.values()) {
      clearTimeout(timer);
    }
    this.followUps.clear();
  }

  /** Transcript writes are the only signal that a day's total has moved. */
  handleActivity(provider: ProviderId): void {
    void this.scan(provider, true);
  }

  handleConfigurationChange(): void {
    this.refresh();
  }

  private refresh(): void {
    for (const provider of PROVIDERS) {
      void this.scan(provider);
    }
  }

  private scan(provider: ProviderId, fromActivity = false): Promise<void> {
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
    const run = this.derive(provider, fromActivity)
      .catch(() => {
        // History is best effort: a failed scan leaves whatever was already stored on screen.
      })
      .finally(() => this.running.delete(provider));
    this.running.set(provider, run);
    return run;
  }

  private async derive(provider: ProviderId, fromActivity: boolean): Promise<void> {
    const unit = UNITS[provider];
    const now = Date.now();
    const stored = this.current(provider, unit);
    const wait = stored
      ? SCAN_FRESH_MS[provider] - (now - Math.max(stored.scannedAt, stored.claimedAt))
      : 0;
    if (stored && wait > 0) {
      this.publish(provider, stored);
      // Only Antigravity waits long enough for a session to end inside the wait, which would leave
      // its last conversation uncounted until the next one.
      if (fromActivity && provider === "antigravity") {
        this.followUp(provider, wait);
      }
      return;
    }
    const today = localDay(new Date(now));
    const from = stored?.scannedAt
      ? localDay(new Date(Math.min(stored.scannedAt, now) - RESCAN_BACK_MS))
      : shiftDay(today, -(FIRST_SCAN_DAYS - 1));
    await this.state.claim(provider, unit, now);
    const scan = await this.read(provider, dayStart(shiftDay(from, -1)), stored);
    const merged = mergeDays(stored?.days ?? {}, scan.days, from);
    const days = scan.pending ? keepHigher(merged, stored?.days ?? {}) : merged;
    const next: StoredHistory = {
      unit,
      days: pruneDays(scan.unchanged ? (stored?.days ?? {}) : days, today),
      scannedAt: now,
      claimedAt: now,
      last: scan.last,
    };
    if (this.disposed) {
      return;
    }
    await this.state.write(provider, next);
    this.publish(provider, next);
    if (scan.pending) {
      this.followUp(provider, SCAN_FRESH_MS[provider]);
    }
  }

  /** One repeat per provider at a time; a repeat that finds nothing left to wait for ends the chain. */
  private followUp(provider: ProviderId, wait: number): void {
    if (this.disposed || this.followUps.has(provider)) {
      return;
    }
    this.followUps.set(
      provider,
      setTimeout(() => {
        this.followUps.delete(provider);
        void this.scan(provider);
      }, wait + FOLLOW_UP_MARGIN_MS),
    );
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
    const scanners: Record<ProviderId, () => Promise<HistoryScan>> = {
      claude: () => scanClaudeHistory(since),
      codex: () => scanCodexHistory(since, stored?.last ?? null),
      antigravity: () => this.scanAntigravity(since, stored?.scannedAt ?? 0),
    };
    return scanners[provider]();
  }
}
