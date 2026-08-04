import { configurationEffect, type ExtensionConfiguration } from "./configuration";
import { formatMoment } from "./formatting";
import type { ReadCoordinator } from "./read-coordinator";
import type { SharedEntry } from "./shared-state";
import {
  cappedRetryAt,
  mergeView,
  type ProviderId,
  type ProviderResult,
  type ProviderView,
} from "./usage";

/** The single cadence for adopting, reading when nobody has, and redrawing. */
const TICK_INTERVAL_MS = 5_000;
/** How long an unused provider process is kept before it is stopped; see `stopIfIdle`. */
const IDLE_STOP_MS = 10 * 60_000;
const HOLD_JITTER_MS = 2_000;

/** One status bar item's worth of surface, with no vscode types in it. */
export interface ProviderDisplay {
  render(view: ProviderView, configuration: ExtensionConfiguration): void;
  loading(configuration: ExtensionConfiguration): void;
  hide(): void;
  dispose(): void;
}

/** Reports that this provider's agent has just run; the directory and the debounce are its own. */
export interface ProviderWatcher {
  start(onChange: () => void): void;
  stop(): void;
  dispose(): void;
}

/**
 * One provider as everything above the wiring sees it. An interface rather than a concrete type,
 * so this file imports neither vscode, the filesystem, nor a child process — which is what lets
 * the rules below be tested without an extension host.
 */
export interface ProviderPort {
  id: ProviderId;
  display: ProviderDisplay;
  read: () => Promise<ProviderResult>;
  watcher: ProviderWatcher;
  isEnabled: (configuration: ExtensionConfiguration) => boolean;
  /** Releases whatever the provider keeps running while it is switched off. */
  stop?: () => void;
  /** Releases it for good; `stop` allows a later restart. */
  dispose?: () => void;
}

/** A rate-limit wait, with the read that ends it already booked. */
interface Hold {
  /** The moment this window reads again: the stated wait, capped. */
  until: Date;
  /**
   * The wait exactly as stated, before the cap. Only ever compared for equality, so adopting the
   * same statement twice is a no-op: the capped moment is measured from now and would creep forward
   * on every tick, leaving a hold that never came due.
   */
  statedAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Everything this window knows about one provider, kept beside it rather than spread across maps
 * keyed alike: forgetting a provider is then one place, and a field added later cannot be missed.
 */
interface ProviderState {
  view: ProviderView | null;
  hold: Hold | null;
  inFlight: Promise<ProviderResult> | null;
  /** When *this* window last read. Decides only whether its provider process is worth keeping;
   *  the floor between reads is the shared lease. */
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

  /** Kept current by the change event, so callers always see the settings as they stand. */
  get settings(): ExtensionConfiguration {
    return this.configuration;
  }

  start(): void {
    this.applyConfiguration();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    void this.refresh({ showLoading: true });
  }

  dispose(): void {
    // Set before anything is torn down: reads in flight are about to be answered by the teardown
    // itself, and those answers describe this window rather than the account.
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

  /** `force` skips the shared floor and the claim race, for refreshes the user asked for. */
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
      // Losing the claim must leave no trace: a window that keeps losing is not using its provider,
      // and stamping `usedAt` here would keep its idle process alive for good.
      return;
    }
    provider.state.usedAt = Date.now();
    try {
      await this.read(provider);
    } catch {
      // Otherwise the lease outlives us and every other window waits out an interval for a read
      // that never happened. Nothing is shown on the item: the last reading stands, with its age.
      await this.reads.abandon(provider.id);
    }
  }

  private async read(provider: Provider): Promise<void> {
    const result = await this.fetchOnce(provider);
    if (this.disposed) {
      // Closing the window stopped the provider from under its own read, so what came back
      // describes the shutdown. Published, it would tell every other window the provider failed.
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
   * wait ends in a read of its own, because the interval can be an hour and the numbers would sit
   * stale for all of it over a refusal that lasted a minute.
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
   * rather than on the age of the reading inside it: a provider that is not signed in answers with
   * a message and no reading at all, and a window still showing a spinner needs to hear it.
   * `mergeView` applies it under the same rule as a failure of our own, which is why that rule
   * lives beside the type rather than in either caller.
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
      // And so is one window's success. Only a read that got through the wait can put a newer entry
      // here with no wait left in it, since no window reads while the wait stands and publishing
      // needs the claim. Without this the refusal outlives the service that made it.
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
   * Adopting, reading, and redrawing all sit on the one interval, because the countdowns move with
   * no new reading behind them. It runs whether or not anything changed — a status bar update every
   * few seconds — which is the price of never showing a number that stopped being true.
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
   * idling. It costs nothing to give up: the next read this window does starts a fresh one.
   */
  private stopIfIdle(provider: Provider): void {
    const { usedAt } = provider.state;
    if (provider.stop && usedAt !== null && Date.now() - usedAt > IDLE_STOP_MS) {
      provider.state.usedAt = null;
      provider.stop();
    }
  }

  /**
   * The stored view keeps what the last read said. The rate-limit wait is layered on here rather
   * than written into the message, so a redraw after the wait has run out states nothing about it:
   * a wait baked into the message would stay on screen long after it had passed.
   *
   * What is stated is the moment rather than the time left. The time left would be a different
   * sentence every few seconds, and a tooltip that changes is a hover the workbench rebuilds from
   * under whoever is reading it.
   */
  private paint(provider: Provider): void {
    const view = provider.state.view ?? { snapshot: null, message: null };
    const { hold } = provider.state;
    const held = hold && hold.until.getTime() > Date.now();
    provider.display.render(
      held
        ? {
            ...view,
            message: `The usage service is rate limiting requests; retrying at ${formatMoment(hold.until)}`,
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
   * Switching a provider back on is answered from the shared reading rather than a read of our own,
   * so an empty item is never the price of a toggle. The rate-limit hold deliberately survives:
   * that wait was not ours to waive.
   */
  private forget(provider: Provider): void {
    provider.state.view = null;
    provider.state.adoptedAt = 0;
    provider.state.usedAt = null;
    provider.display.hide();
  }

  /**
   * One read per provider at a time; every caller shares the in-flight request. `ReadCoordinator`
   * relies on this: it uses the window id alone as the claim token.
   */
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
