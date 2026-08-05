import { MIN_REFRESH_INTERVAL_SECONDS } from "./configuration";
import type { SharedEntry, SharedUsageState } from "./shared-state";
import type { ProviderId, ProviderView } from "./usage";

/**
 * How long the window that read last keeps its head start: long enough that reads settle on one
 * window, short enough that closing that window is not felt.
 */
const INCUMBENT_GRACE_MS = 5_000;
/**
 * Long enough to cover the store carrying a write to the other windows, which takes tens of
 * milliseconds once the windows are up and rather longer while they are all still starting.
 */
const CLAIM_SETTLE_MS = 150;
const CLAIM_SETTLE_JITTER_MS = 150;
/**
 * The stagger a window waits before contesting a lease, as a slot count and the distance between
 * slots. The distance is what makes the wait worth taking: it is longer than a claim takes to
 * settle, so a window reaching its slot is looking at a store that has had time to carry whoever
 * went before it. The count sets how far the stagger reaches, and a second and a half is the delay
 * in carrying a write that it can still cover.
 *
 * Neither is a count of windows. However many are open, only the earliest slot any of them landed
 * in decides anything, and windows that share that slot settle it between them. The span is paid
 * once, on the first read after a window opens, and the window the reads have settled on skips it.
 */
const CLAIM_SLOTS = 6;
const CLAIM_SLOT_MS = 350;

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
  /** When this window last set out to read each provider; see `publish`. */
  private readonly claimedAt = new Map<ProviderId, number>();

  constructor(
    private readonly shared: SharedUsageState,
    /** Injected so the tests need not wait out the settling they are checking. */
    private readonly settle: (ms: number) => Promise<void> = delay,
    /**
     * Distinct between the windows running at the same time, which is all the lease compares. It
     * also picks the slot, so the tests name it rather than have the window draw one and read the
     * order back out of the result.
     */
    private readonly windowId: string = Math.random().toString(36).slice(2, 10),
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
    // Kept here rather than read back from the entry, which any other window may have written over
    // by the time the read answers. It is what `publish` weighs the result against.
    this.claimedAt.set(provider, Date.now());
    return this.shared.claim(provider, this.windowId);
  }

  /**
   * Which slot this window contests a free lease in. Derived from the window id rather than drawn
   * at random, so the order between the windows open right now is decided before they need it and
   * does not change from one read to the next.
   */
  private get slot(): number {
    let hash = 0;
    for (const character of this.windowId) {
      hash = (hash * 31 + character.charCodeAt(0)) % CLAIM_SLOTS;
    }
    return hash * CLAIM_SLOT_MS;
  }

  /**
   * Two windows can find the same lease free before either write has landed, so a claim is settled
   * before it is trusted: write it, pause for a jittered stretch, then ask the store who got there.
   * Only that window spends a request. This is not a lock and cannot be one, but it turns a
   * simultaneous arrival into a single read.
   *
   * The settling alone is not enough for windows that come due in the same instant — every VS Code
   * window restored together does — because each writes before any other's write has arrived, and
   * so reads back its own stamp. Waiting out a slot first is what separates those writes, and the
   * window that read last skips the wait: it is the one the reads are meant to settle on, and in
   * the steady state it is the only one contesting anything.
   */
  async wins(provider: ProviderId): Promise<boolean> {
    if (this.shared.read(provider)?.owner !== this.windowId) {
      await this.settle(this.slot);
      // Standing down here rather than after claiming is the point of the wait: a stamp left by a
      // window that is not reading is one the window that is cannot publish under.
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
    // We are holding someone else's stamp, so the check above cannot answer it: several windows
    // claimed in the same instant and each is holding whichever write reached it last. The one
    // that claimed latest is the one that reads, which is the same rule the check above applies —
    // holding your own stamp means yours was the last to arrive — and the same one the store
    // itself keeps to. It has to be the latest rather than the earliest, or every window that
    // claimed before the last one would find a later stamp in its hands and read.
    //
    // Only a window that saw a free lease when it claimed gets this far, so what is found here is
    // always a claim made alongside ours rather than one we should have deferred to.
    const claimedAt = this.claimedAt.get(provider) ?? 0;
    return settled.readAt === claimedAt
      ? this.windowId > settled.owner
      : settled.readAt < claimedAt;
  }

  /**
   * Whether the lease is still stamped with this window. Only handing one back asks this: a lease
   * is a thing one window holds, and returning one that has since passed on would set every window
   * reading at once. What may be written under it is a separate question, answered in `publish`.
   */
  private holdsClaim(provider: ProviderId): boolean {
    return this.shared.read(provider)?.owner === this.windowId;
  }

  /**
   * What a result is weighed against is the reading already published, not the stamp on the lease.
   * The lease cannot answer this: the store carries writes to the windows in whatever order it
   * manages, so two windows that claimed in the same instant each end up holding the other's stamp,
   * and asking it who reads would have both of them drop the answer they had just spent a request
   * on. Nothing published since we set out is what makes ours the newest reading there is — and it
   * is the same question the lease was standing in for, asked of the reading directly.
   *
   * So a slow read still writes nothing over the forced refresh that overtook it, and a read nobody
   * else duplicated still lands, whatever the lease says by the time it answers.
   */
  async publish(provider: ProviderId, view: ProviderView, retryAt: Date | null): Promise<void> {
    const claimedAt = this.claimedAt.get(provider);
    const published = this.shared.read(provider)?.publishedAt ?? 0;
    if (claimedAt !== undefined && published <= claimedAt) {
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
