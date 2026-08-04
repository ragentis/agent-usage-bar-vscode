import { MIN_REFRESH_INTERVAL_SECONDS } from "./configuration";
import type { SharedEntry, SharedUsageState } from "./shared-state";
import type { ProviderId, ProviderView } from "./usage";

/**
 * How long the window that read last keeps its head start: long enough that reads settle on one
 * window, short enough that closing that window is not felt.
 */
const INCUMBENT_GRACE_MS = 5_000;
const CLAIM_SETTLE_MS = 100;
const CLAIM_SETTLE_JITTER_MS = 150;

/** An impossibly old stamp, which is what "nobody is reading" looks like to every other window. */
const NO_LEASE = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Which window reads, and when. Every VS Code window runs its own copy of the extension, so six
 * open windows would otherwise ask the same question six times at the same instant. The shared
 * entry prevents it: a stamp saying some window set out to read is all the others need to stand
 * down.
 *
 * No leader is elected. The window that read last is held to the plain floor while the others wait
 * `INCUMBENT_GRACE_MS` longer, which settles reads on one window. A window closed mid-read needs no
 * detection: its stamp ages out like any other.
 */
export class ReadCoordinator {
  /** Distinct between the windows running at the same time, which is all the lease compares. */
  private readonly windowId = Math.random().toString(36).slice(2, 10);

  constructor(
    private readonly shared: SharedUsageState,
    /** Injected so the tests need not wait out the settling they are checking. */
    private readonly settle: (ms: number) => Promise<void> = delay,
  ) {}

  latest(provider: ProviderId): SharedEntry | null {
    return this.shared.read(provider);
  }

  /**
   * The floor under every automatic read, whoever asked for it and from whichever window.
   * Transcript writes arrive in bursts with pauses longer than the watcher's debounce, so one long
   * turn would otherwise spend several requests per open window on numbers that had barely moved.
   * The last reading stays on screen with its age stated, and whoever does read publishes it.
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
   * The background read is timed off the shared stamp rather than a timer of each window's own.
   * Windows restored together would otherwise hold timers in step and fire as one, and a window
   * closed mid-read would leave the rest waiting out a whole interval for a read that never came.
   * Whoever notices the wait has run out does the reading.
   *
   * Two cases fall back to the floor instead of the configured interval. A stamp with nothing
   * published after it is a read still in flight, or a window closed during one; no window may read
   * before the floor in any case, so a claim with nothing to show for it by then is not worth an
   * interval. An expired `retryAt` is the same: waiting out five minutes on top of ten seconds of
   * rate limiting would buy nothing but stale numbers. Either way this makes the read due, not
   * ours — the claim still follows.
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

  /**
   * Stamps the lease without contesting it, for a read the user asked for: it goes ahead whatever
   * the others are doing, but must still say so, or the next window reads again over a reading that
   * is a second old.
   */
  take(provider: ProviderId): PromiseLike<void> {
    return this.shared.claim(provider, this.windowId);
  }

  /**
   * Two windows can find the same lease free before either write has landed, so a claim is settled
   * before it is trusted: write it, pause for a jittered stretch, then ask the store who got there.
   * Only that window spends a request. This is not a lock and cannot be one, but it turns a
   * simultaneous arrival into a single read.
   */
  async wins(provider: ProviderId): Promise<boolean> {
    await this.take(provider);
    await this.settle(CLAIM_SETTLE_MS + Math.random() * CLAIM_SETTLE_JITTER_MS);
    return this.shared.read(provider)?.owner === this.windowId;
  }

  /**
   * A result is ours to write only while the claim is still ours. A read can outlive its claim — a
   * forced refresh lands over the top of it — and would otherwise put an older reading where a
   * newer one sits. The window id suffices as a token: one window never has two different reads of
   * a provider in flight, because they share the single request (`UsageBar.fetchOnce`).
   */
  private holdsClaim(provider: ProviderId): boolean {
    return this.shared.read(provider)?.owner === this.windowId;
  }

  async publish(provider: ProviderId, view: ProviderView, retryAt: Date | null): Promise<void> {
    if (this.holdsClaim(provider)) {
      await this.shared.publish(provider, { owner: this.windowId, view, retryAt });
    }
  }

  /**
   * For a read that fell over rather than answered. The interval was never spent, so the other
   * windows should not wait it out — but a lease that has since passed to another window is not
   * ours to hand back, and returning it would set all of them reading at once.
   */
  async abandon(provider: ProviderId): Promise<void> {
    if (this.holdsClaim(provider)) {
      await this.shared.rewind(provider, NO_LEASE);
    }
  }
}
