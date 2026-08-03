import { configurationEffect, type ExtensionConfiguration } from "./configuration";
import { formatWait } from "./formatting";
import type { ReadCoordinator } from "./read-coordinator";
import type { SharedEntry } from "./shared-state";
import {
  cappedRetryAt,
  mergeView,
  type ProviderId,
  type ProviderResult,
  type ProviderView,
} from "./usage";

/** The one cadence this window runs on: it adopts, it reads when nobody has, and it redraws. */
const TICK_INTERVAL_MS = 5_000;
/** A provider process this window has stopped using belongs to whichever window is reading. */
const IDLE_STOP_MS = 10 * 60_000;
const HOLD_JITTER_MS = 2_000;

/** One status bar item's worth of surface, with nothing of how it is drawn. */
export interface ProviderDisplay {
  render(view: ProviderView, configuration: ExtensionConfiguration): void;
  loading(configuration: ExtensionConfiguration): void;
  hide(): void;
  dispose(): void;
}

/** Reports that this provider's agent has just run. Which directory, and how long a burst is left
 *  to settle, are its own business. */
export interface ProviderWatcher {
  start(onChange: () => void): void;
  stop(): void;
  dispose(): void;
}

/**
 * One provider as everything above the wiring sees it. Stated as an interface rather than built
 * here, which is what leaves this file with no import of vscode, of the filesystem, or of a child
 * process — and so lets the rules below be exercised whole, without an extension host.
 */
export interface ProviderPort {
  id: ProviderId;
  display: ProviderDisplay;
  read: () => Promise<ProviderResult>;
  watcher: ProviderWatcher;
  isEnabled: (configuration: ExtensionConfiguration) => boolean;
  /** Releases whatever the provider keeps running, for the stretch it is switched off. */
  stop?: () => void;
  /** Releases it for good, unlike `stop`, which rules out nothing later. */
  dispose?: () => void;
}

/** Held while a provider has asked to be left alone, with the read that ends the wait booked. */
interface Hold {
  /** The moment this window reads again: the stated wait, capped. */
  until: Date;
  /**
   * The wait exactly as stated, before the cap. Only ever compared for equality, so that adopting
   * the same statement twice is a no-op — the capped moment is measured from now and would creep
   * forward on every tick, leaving a hold that never came due.
   */
  statedAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Everything this window knows about one provider, kept beside that provider rather than spread
 * across maps that all take the same key: forgetting one is then a single place, and a field added
 * later cannot be the one the forgetting misses.
 */
interface ProviderState {
  view: ProviderView | null;
  hold: Hold | null;
  inFlight: Promise<ProviderResult> | null;
  /** When *this* window last read, which decides only whether its provider process is still worth
   *  keeping. The floor between reads is the shared lease, not this. */
  usedAt: number | null;
  /** The newest publication already taken from another window, so it is taken exactly once. */
  adoptedAt: number;
}

interface Provider extends ProviderPort {
  readonly state: ProviderState;
}

export class UsageBar {
  private readonly providers: Provider[];
  private configuration: ExtensionConfiguration;
  private disposed = false;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(
    ports: readonly ProviderPort[],
    private readonly reads: ReadCoordinator,
    private readonly readConfiguration: () => ExtensionConfiguration,
  ) {
    this.providers = ports.map((port) => ({
      ...port,
      state: { view: null, hold: null, inFlight: null, usedAt: null, adoptedAt: 0 },
    }));
    this.configuration = readConfiguration();
  }

  /** Kept current by the change event, so whoever asks always sees the settings as they stand. */
  get settings(): ExtensionConfiguration {
    return this.configuration;
  }

  start(): void {
    this.applyConfiguration();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    void this.refresh({ showLoading: true });
  }

  dispose(): void {
    // Set before anything is torn down, because reads already in flight are about to be answered
    // by the teardown itself, and their answers are about this window rather than the account.
    this.disposed = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const provider of this.providers) {
      this.releaseHold(provider);
      provider.watcher.dispose();
      provider.display.dispose();
      provider.dispose?.();
    }
  }

  /** `force` belongs to the paths the user drove: a refresh asked for should do what it says. */
  async refresh(
    options: { only?: ProviderId; showLoading?: boolean; force?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const targets = this.providers.filter(
      (provider) => !options.only || provider.id === options.only,
    );
    if (options.showLoading) {
      for (const provider of targets) {
        if (provider.isEnabled(this.configuration)) {
          provider.display.loading(this.configuration);
        }
      }
    }
    await Promise.all(
      targets.map((provider) => this.refreshProvider(provider, options.force ?? false)),
    );
  }

  handleConfigurationChange(): void {
    const previous = this.configuration;
    this.configuration = this.readConfiguration();
    switch (configurationEffect(previous, this.configuration)) {
      case "refresh":
        this.applyConfiguration();
        void this.refresh();
        break;
      case "redraw":
        this.redraw();
        break;
    }
  }

  /** Decides whether this window is the one to read; `read` is the half that actually asks. */
  private async refreshProvider(provider: Provider, force: boolean): Promise<void> {
    if (!provider.isEnabled(this.configuration)) {
      this.forget(provider);
      return;
    }
    const shared = this.adopt(provider);
    if (this.holdOff(provider)) {
      return;
    }
    if (!force && this.reads.tooSoon(shared)) {
      return;
    }
    if (force) {
      await this.reads.take(provider.id);
    } else if (!(await this.reads.wins(provider.id))) {
      // Losing the claim must leave no trace: a window that keeps losing is a window not using its
      // provider, and saying otherwise here is what would keep its idle process alive for good.
      return;
    }
    provider.state.usedAt = Date.now();
    try {
      await this.read(provider);
    } catch {
      // The lease outlives us otherwise, and every other window waits out an interval for a read
      // that was never spent. Nothing is said on the item: the last reading stands, with its age.
      await this.reads.abandon(provider.id);
    }
  }

  private async read(provider: Provider): Promise<void> {
    const result = await this.fetchOnce(provider);
    if (this.disposed) {
      // This window is closing, and closing it stopped the provider from under its own read. What
      // came back describes the shutdown and nothing else; published, it would tell every other
      // window that the provider had failed.
      return;
    }
    // The provider may have been switched off while the read was running.
    if (!provider.isEnabled(this.configuration)) {
      this.forget(provider);
      await this.reads.abandon(provider.id);
      return;
    }
    const retryAt = result.status === "ok" ? undefined : result.retryAt;
    if (retryAt) {
      this.hold(provider, retryAt);
    } else {
      this.releaseHold(provider);
    }
    const view = nextView(provider.state.view, result);
    provider.state.view = view;
    this.paint(provider);
    await this.reads.publish(provider.id, view, retryAt ?? null);
  }

  /**
   * Retrying before the service says to is what earns a rate limit, so the stated wait is honoured
   * for every trigger alike: the background interval, a transcript write, and a manual refresh. The
   * wait ends in a read of its own, because that interval can be an hour and the numbers would sit
   * stale the whole of it over a refusal that lasted a minute.
   */
  private hold(provider: Provider, stated: Date): void {
    clearTimeout(provider.state.hold?.timer);
    // Capped here as well as where the header is read, because a wait also arrives from another
    // window's entry, which during an update is written by a version this one knows nothing about.
    const until = cappedRetryAt(stated);
    const timer = setTimeout(
      () => {
        this.releaseHold(provider);
        void this.refresh({ only: provider.id });
      },
      // Jittered, because every window shares this deadline and a service that just refused a
      // burst should not be answered with another one the instant its wait runs out.
      Math.max(0, until.getTime() - Date.now()) + Math.random() * HOLD_JITTER_MS,
    );
    provider.state.hold = { until, statedAt: stated.getTime(), timer };
  }

  private releaseHold(provider: Provider): void {
    if (provider.state.hold) {
      clearTimeout(provider.state.hold.timer);
      provider.state.hold = null;
    }
  }

  private holdOff(provider: Provider): boolean {
    const { hold } = provider.state;
    if (!hold) {
      return false;
    }
    if (hold.until.getTime() <= Date.now()) {
      this.releaseHold(provider);
      return false;
    }
    this.paint(provider);
    return true;
  }

  /**
   * Takes whatever another window published since we last looked. Keyed on when it was written
   * rather than on the age of the reading inside it, because the most useful thing another window
   * can learn is often that there is no reading to be had: a provider that is not signed in
   * answers with a message and nothing else, and a window still showing a spinner needs to hear
   * it. `mergeView` then applies it under the same rule as a failure of our own, which is why the
   * rule lives beside the type rather than in either caller.
   */
  private adopt(provider: Provider): SharedEntry | null {
    const shared = this.reads.latest(provider.id);
    if (!shared) {
      return null;
    }
    const news = shared.publishedAt > provider.state.adoptedAt;
    if (shared.retryAt && shared.retryAt.getTime() > Date.now()) {
      // One window's refusal is the whole machine's: the credentials and the service are the same.
      if (provider.state.hold?.statedAt !== shared.retryAt.getTime()) {
        this.hold(provider, shared.retryAt);
      }
    } else if (news) {
      // And so is one window's success. A wait is only ever cleared by a read that got through it,
      // because no window reads while the wait stands and a publication needs the claim: nothing
      // else can put a newer entry here with no wait left in it. Without this the refusal outlives
      // the service that made it, and the item states a failure over numbers seconds old.
      this.releaseHold(provider);
    }
    if (news) {
      provider.state.adoptedAt = shared.publishedAt;
      provider.state.view = mergeView(provider.state.view, shared.view);
      this.paint(provider);
    }
    return shared;
  }

  /**
   * Adopting, reading, and redrawing all sit on the one interval. The countdowns move with no new
   * reading behind them, so they need a beat of their own — and a beat this window is already
   * keeping. It is spent whether or not anything changed, which is a status bar update every few
   * seconds; that is the price of never showing a number that stopped being true.
   */
  private tick(): void {
    for (const provider of this.providers) {
      if (provider.isEnabled(this.configuration)) {
        const shared = this.adopt(provider);
        if (this.reads.overdue(shared, this.configuration.refreshIntervalSeconds)) {
          void this.refresh({ only: provider.id });
        }
        if (provider.state.view) {
          this.paint(provider);
        }
      }
      this.stopIfIdle(provider);
    }
  }

  /**
   * Once the reading has settled on another window, the child process this one started is only
   * idling. It costs nothing to give up, because the next read this window does starts a fresh one.
   */
  private stopIfIdle(provider: Provider): void {
    const { usedAt } = provider.state;
    if (provider.stop && usedAt !== null && Date.now() - usedAt > IDLE_STOP_MS) {
      provider.state.usedAt = null;
      provider.stop();
    }
  }

  /**
   * The stored view keeps what the last read said; the wait is layered on here rather than written
   * into it, so every redraw states the time left now instead of repeating the number the refusal
   * was born with.
   */
  private paint(provider: Provider): void {
    const view = provider.state.view ?? { snapshot: null, message: null };
    const { hold } = provider.state;
    const held = hold && hold.until.getTime() > Date.now();
    provider.display.render(
      held
        ? {
            ...view,
            message: `The usage service is rate limiting requests; retry in ${formatWait(hold.until)}`,
          }
        : view,
      this.configuration,
    );
  }

  private redraw(): void {
    for (const provider of this.providers) {
      if (provider.state.view && provider.isEnabled(this.configuration)) {
        this.paint(provider);
      }
    }
  }

  /**
   * Switching a provider back on is answered from the shared reading rather than by a read of our
   * own, so an empty item is never the price of a toggle. The rate-limit hold deliberately
   * survives: that wait was not ours to waive.
   */
  private forget(provider: Provider): void {
    provider.state.view = null;
    provider.state.adoptedAt = 0;
    provider.state.usedAt = null;
    provider.display.hide();
  }

  private fetchOnce(provider: Provider): Promise<ProviderResult> {
    const pending = provider.state.inFlight;
    if (pending) {
      return pending;
    }
    const request = provider.read().finally(() => {
      provider.state.inFlight = null;
    });
    provider.state.inFlight = request;
    return request;
  }

  private applyConfiguration(): void {
    for (const provider of this.providers) {
      provider.watcher.stop();
      if (provider.isEnabled(this.configuration)) {
        provider.watcher.start(() => void this.refresh({ only: provider.id }));
      } else {
        provider.stop?.();
      }
    }
  }
}

function nextView(previous: ProviderView | null, result: ProviderResult): ProviderView {
  return mergeView(
    previous,
    result.status === "ok"
      ? { snapshot: result.snapshot, message: null }
      : { snapshot: null, message: result.message },
  );
}
