import { MIN_REFRESH_INTERVAL_SECONDS } from "./configuration";
import type { SharedEntry, SharedUsageState } from "./shared-state";
import type { ProviderId, ProviderView } from "./usage";

const INCUMBENT_GRACE_MS = 5_000;

// Claims need time to propagate before contenders decide who won.
const CLAIM_SETTLE_MS = 150;
const CLAIM_SETTLE_JITTER_MS = 150;

/**
 * Non-incumbent windows contest a free lease in stable slots longer than claim settlement. Slots
 * reduce simultaneous claims but do not limit the number of windows; collisions settle below.
 */
const CLAIM_SLOTS = 6;
const CLAIM_SLOT_MS = 350;

const NO_LEASE = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared timestamps suppress duplicate reads without electing a permanent leader. The previous
 * reader gets a brief head start; abandoned claims expire without window-lifecycle tracking.
 */
export class ReadCoordinator {
  private readonly claimedAt = new Map<ProviderId, number>();

  constructor(
    private readonly shared: SharedUsageState,
    private readonly settle: (ms: number) => Promise<void> = delay,
    private readonly windowId: string = Math.random().toString(36).slice(2, 10),
  ) {}

  latest(provider: ProviderId): SharedEntry | null {
    return this.shared.read(provider);
  }

  tooSoon(entry: SharedEntry | null): boolean {
    if (!entry) {
      return false;
    }
    const floor = MIN_REFRESH_INTERVAL_SECONDS * 1_000;
    const incumbent = entry.owner === this.windowId;
    return Date.now() - entry.readAt < (incumbent ? floor : floor + INCUMBENT_GRACE_MS);
  }

  /**
   * Pending claims and expired rate-limit waits use the minimum floor instead of the configured
   * interval, allowing prompt recovery from a window closed mid-read or an expired provider wait.
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

  take(provider: ProviderId): PromiseLike<void> {
    // Keep the local timestamp because another window may replace the shared claim before this read
    // completes. `publish` compares the result against this original claim.
    this.claimedAt.set(provider, Date.now());
    return this.shared.claim(provider, this.windowId);
  }

  private get slot(): number {
    let hash = 0;
    for (const character of this.windowId) {
      hash = (hash * 31 + character.charCodeAt(0)) % CLAIM_SLOTS;
    }
    return hash * CLAIM_SLOT_MS;
  }

  /**
   * Slots separate windows that become due together; settlement resolves slot collisions. Shared
   * state is not an atomic lock, so exact ties may still issue two requests, but `publish` prevents
   * stale results from overwriting newer ones.
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

  private holdsClaim(provider: ProviderId): boolean {
    return this.shared.read(provider)?.owner === this.windowId;
  }

  /**
   * Publication time, rather than final lease ownership, preserves a valid result from a claim race
   * while preventing a slow read from overwriting a newer forced refresh.
   */
  async publish(
    provider: ProviderId,
    view: ProviderView,
    retryAt: Date | null,
    refusals = 0,
  ): Promise<void> {
    const claimedAt = this.claimedAt.get(provider);
    const published = this.shared.read(provider)?.publishedAt ?? 0;
    if (claimedAt !== undefined && published <= claimedAt) {
      await this.shared.publish(provider, { owner: this.windowId, view, retryAt, refusals });
    }
  }

  async abandon(provider: ProviderId): Promise<void> {
    if (this.holdsClaim(provider)) {
      await this.shared.rewind(provider, NO_LEASE);
    }
  }
}
