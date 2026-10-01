import { providerEnabled, type ExtensionConfiguration } from "./configuration";
import {
  dayStart,
  keepHigher,
  localDay,
  MAX_STORED_DAYS,
  mergeDays,
  pruneDays,
  shiftDay,
  type DailyTotals,
  type HistoryScan,
  type HistoryUnit,
} from "./history";
import type { StoredHistory, UsageHistoryState } from "./history-store";
import { PROVIDER_IDS, type ProviderId } from "./usage";

const UNITS: Record<ProviderId, HistoryUnit> = {
  claude: "tokens",
  codex: "percent",
  antigravity: "tokens",
};

/** `stored` is what the last scan wrote, or null when there is none. */
export type HistoryScanner = (since: number, stored: StoredHistory | null) => Promise<HistoryScan>;

const DAY_MS = 24 * 60 * 60_000;

/**
 * A later scan recomputes only the days that can still change. It reads one more day back so the
 * first of them has an earlier reading as a baseline.
 */
const RESCAN_BACK_MS = DAY_MS;

/**
 * A scan this recent, by any window, is not repeated. An Antigravity scan starts a process, so its
 * interval is longer.
 */
const SCAN_FRESH_MS: Record<ProviderId, number> = {
  claude: 2 * 60_000,
  codex: 2 * 60_000,
  antigravity: 10 * 60_000,
};

/** Added to the wait so the repeated scan is not rejected as too recent. */
const FOLLOW_UP_MARGIN_MS = 1_000;

/** Delays the first scan so activation time goes to the status bar reading. */
const START_DELAY_MS = 4_000;

function isEnabled(provider: ProviderId, configuration: ExtensionConfiguration): boolean {
  return providerEnabled(configuration, provider) && configuration.showHistory;
}

/**
 * Every window derives the same totals from disk, so the lease that coordinates live readings is
 * not needed. `claimedAt` only avoids duplicate scans.
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
    private readonly scanners: Record<ProviderId, HistoryScanner>,
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

  /** A write by the agent is the only signal that a day's total has changed. */
  handleActivity(provider: ProviderId): void {
    void this.scan(provider, true);
  }

  handleConfigurationChange(): void {
    this.refresh();
  }

  private refresh(): void {
    for (const provider of PROVIDER_IDS) {
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
      // Only Antigravity's interval is long enough for a session to end within it. Without a
      // follow-up, its last conversation would stay uncounted until the next session.
      if (fromActivity && provider === "antigravity") {
        this.followUp(provider, wait);
      }
      return;
    }
    const today = localDay(new Date(now));
    const from = stored?.scannedAt
      ? localDay(new Date(Math.min(stored.scannedAt, now) - RESCAN_BACK_MS))
      : shiftDay(today, -(MAX_STORED_DAYS - 1));
    await this.state.claim(provider, unit, now);
    const scan = await this.scanners[provider](dayStart(shiftDay(from, -1)), stored);
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

  /** One pending repeat per provider. A repeat that finds nothing pending schedules no other. */
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

  /** A stored entry whose unit differs from the provider's cannot be merged and is ignored. */
  private current(provider: ProviderId, unit: HistoryUnit): StoredHistory | null {
    const stored = this.state.read(provider);
    return stored && stored.unit === unit ? stored : null;
  }
}
