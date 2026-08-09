import { MIN_REFRESH_INTERVAL_SECONDS } from "./configuration";
import type { SharedEntry, SharedUsageState } from "./shared-state";
import type { ProviderId, ProviderView } from "./usage";

/** Briefly favors the previous reader without delaying recovery when that window closes. */
const INCUMBENT_GRACE_MS = 5_000;
/**
 * Allows a claim to propagate through the shared store before any window decides whether it won.
 * Propagation normally takes tens of milliseconds but is slower while windows are starting.
 */
const CLAIM_SETTLE_MS = 150;
const CLAIM_SETTLE_JITTER_MS = 150;
/**
 * Staggers windows before they contest a free lease. Each slot is longer than claim settlement, so
 * a window normally sees claims from earlier slots before writing its own. The full range can also
 * absorb up to 1.75 seconds of propagation delay during startup.
 *
 * The slot count does not limit the number of windows. Windows in the earliest occupied slot
 * compete through claim settlement; later slots observe their claim. Only non-incumbent windows
 * pay this delay.
 */
const CLAIM_SLOTS = 6;
const CLAIM_SLOT_MS = 350;

/** A timestamp old enough to make the lease immediately available. */
const NO_LEASE = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coordinates automatic reads across VS Code windows through timestamps in shared state. A recent
 * claim suppresses duplicate reads without electing a permanent leader.
 *
 * The previous reader uses the normal refresh floor; other windows wait
 * `INCUMBENT_GRACE_MS` longer. This normally keeps one window responsible for reads, while an
 * abandoned claim expires without explicit window-lifecycle tracking.
 */
export class ReadCoordinator {
  /** Claim timestamp used to reject results older than the latest published reading. */
  private readonly claimedAt = new Map<ProviderId, number>();

  constructor(
    private readonly shared: SharedUsageState,
    /** Injected so tests can control claim settlement without real delays. */
    private readonly settle: (ms: number) => Promise<void> = delay,
    /**
     * Unique among concurrent windows. It identifies claims and deterministically selects a slot,
     * which also makes slot ordering controllable in tests.
     */
    private readonly windowId: string = Math.random().toString(36).slice(2, 10),
  ) {}

  latest(provider: ProviderId): SharedEntry | null {
    return this.shared.read(provider);
  }

  /**
   * Enforces the shared minimum interval for automatic reads. Non-incumbent windows also wait for
   * the incumbent grace period, preventing watcher bursts from producing one request per window.
   */
  tooSoon(entry: SharedEntry | null): boolean {
    if (!entry) {
      return false;
    }
    const floor = MIN_REFRESH_INTERVAL_SECONDS * 1_000;
    const incumbent = entry.owner === this.windowId;
    return Date.now() - entry.readAt < (incumbent ? floor : floor + INCUMBENT_GRACE_MS);
  }

  /**
   * Determines due time from shared state instead of per-window timers, so windows restored
   * together do not schedule duplicate reads.
   *
   * Pending claims and expired rate-limit waits use the minimum interval rather than the configured
   * interval. This lets another window recover promptly from a reader that closed mid-request and
   * refresh as soon as a rate-limit wait expires. A due read must still win a claim.
   */
  overdue(entry: SharedEntry | null, intervalSeconds: number): boolean {
    if (entry === null) {
      return true;
    }
    const since = Date.now() - entry.readAt;
    const pending = entry.publishedAt < entry.readAt;
    const waited = entry.retryAt !== null && entry.retryAt.getTime() <= Date.now();
    return since >= (pending || waited ? MIN_REFRESH_INTERVAL_SECONDS : intervalSeconds) * 1_000;
  }

  /** Records a manual read without contesting the lease, so other windows observe its timestamp. */
  take(provider: ProviderId): PromiseLike<void> {
    // Keep the local timestamp because another window may replace the shared claim before this read
    // completes. `publish` compares the result against this original claim.
    this.claimedAt.set(provider, Date.now());
    return this.shared.claim(provider, this.windowId);
  }

  /** Deterministic slot assignment keeps the ordering between open windows stable across reads. */
  private get slot(): number {
    let hash = 0;
    for (const character of this.windowId) {
      hash = (hash * 31 + character.charCodeAt(0)) % CLAIM_SLOTS;
    }
    return hash * CLAIM_SLOT_MS;
  }

  /**
   * Claims a due read after the window's slot delay, then waits for shared-state propagation before
   * checking ownership. The slot delay separates windows that become due together; settlement
   * resolves windows that share a slot. The incumbent skips the slot delay.
   *
   * Shared state is not an atomic lock, so an exact tie can still produce two requests. `publish`
   * prevents either result from overwriting a newer reading.
   */
  async wins(provider: ProviderId): Promise<boolean> {
    if (this.shared.read(provider)?.owner !== this.windowId) {
      await this.settle(this.slot);
      // Recheck before claiming so a later slot does not overwrite a valid earlier claim.
      if (this.tooSoon(this.shared.read(provider))) {
        return false;
      }
    }
    await this.take(provider);
    await this.settle(CLAIM_SETTLE_MS + Math.random() * CLAIM_SETTLE_JITTER_MS);
    const settled = this.shared.read(provider);
    if (!settled || settled.owner === this.windowId) {
      return true;
    }
    // Simultaneous claimants can each observe another window's stamp. Select the latest timestamp,
    // then use the window id as a deterministic tie-breaker. Every claimant reaching this branch
    // observed a free lease before writing, so the competing stamp belongs to the same claim race.
    const claimedAt = this.claimedAt.get(provider) ?? 0;
    return settled.readAt === claimedAt
      ? this.windowId > settled.owner
      : settled.readAt < claimedAt;
  }

  /** Prevents this window from releasing a lease that another window has since claimed. */
  private holdsClaim(provider: ProviderId): boolean {
    return this.shared.read(provider)?.owner === this.windowId;
  }

  /**
   * Publishes only if no newer reading appeared after this window claimed. Lease ownership is not
   * used here because simultaneous claimants may observe each other's writes in different orders.
   * Comparing publication time preserves a valid result from a claim race while preventing a slow
   * read from overwriting a newer forced refresh.
   */
  async publish(provider: ProviderId, view: ProviderView, retryAt: Date | null): Promise<void> {
    const claimedAt = this.claimedAt.get(provider);
    const published = this.shared.read(provider)?.publishedAt ?? 0;
    if (claimedAt !== undefined && published <= claimedAt) {
      await this.shared.publish(provider, { owner: this.windowId, view, retryAt });
    }
  }

  /** Releases a failed read immediately, but only while this window still owns the lease. */
  async abandon(provider: ProviderId): Promise<void> {
    if (this.holdsClaim(provider)) {
      await this.shared.rewind(provider, NO_LEASE);
    }
  }
}
