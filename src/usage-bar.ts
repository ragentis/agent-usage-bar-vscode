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

const TICK_INTERVAL_MS = 5_000;
/** How long an unused provider process is kept before it is stopped; see `stopIfIdle`. */
const IDLE_STOP_MS = 10 * 60_000;
const HOLD_JITTER_MS = 2_000;

export interface ProviderDisplay {
  render(view: ProviderView, configuration: ExtensionConfiguration): void;
  loading(configuration: ExtensionConfiguration): void;
  hide(): void;
  dispose(): void;
}

export interface ProviderWatcher {
  start(onChange: () => void): void;
  stop(): void;
  dispose(): void;
}

export interface ProviderPort {
  id: ProviderId;
  display: ProviderDisplay;
  read: () => Promise<ProviderResult>;
  watcher: ProviderWatcher;
  isEnabled: (configuration: ExtensionConfiguration) => boolean;
  stop?: () => void;
  dispose?: () => void;
}

interface Hold {
  until: Date;
  /**
   * Input deadline before this window reapplies the cap. Equality prevents an adopted deadline
   * from being capped again on every tick, which would keep moving the retry forward.
   */
  statedAt: number;
  timer: NodeJS.Timeout;
}

interface ProviderState {
  view: ProviderView | null;
  hold: Hold | null;
  inFlight: Promise<ProviderResult> | null;
  /** Last local read; used only for process idling, not refresh coordination. */
  usedAt: number | null;
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

  get settings(): ExtensionConfiguration {
    return this.configuration;
  }

  start(): void {
    this.applyConfiguration();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    void this.refresh({ showLoading: true });
  }

  dispose(): void {
    // Mark disposal first so results caused by teardown are not published as provider failures.
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
      // A lost claim is not local provider use and must not extend the process idle timeout.
      return;
    }
    provider.state.usedAt = Date.now();
    try {
      await this.read(provider);
    } catch {
      // Release the lease so other windows need not wait after a local read throws.
      await this.reads.abandon(provider.id);
    }
  }

  private async read(provider: Provider): Promise<void> {
    const result = await this.fetchOnce(provider);
    if (this.disposed) {
      // Teardown can cause the read to fail; do not publish that local shutdown as provider state.
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
   * A provider retry deadline applies even to manual refresh and schedules its own read, avoiding a
   * full refresh interval after a short refusal.
   */
  private hold(provider: Provider, stated: Date): void {
    clearTimeout(provider.state.hold?.timer);
    // Cap adopted waits as well as local responses because another window may run a different version.
    const until = cappedRetryAt(stated);
    const timer = setTimeout(
      () => {
        this.releaseHold(provider);
        void this.refresh({ only: provider.id });
      },
      // Jitter prevents all windows from retrying at the same shared deadline.
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
   * Publication time also carries failures without a snapshot, allowing an initially loading window
   * to adopt a no-sign-in result. `mergeView` preserves the last good reading.
   */
  private adopt(provider: Provider): SharedEntry | null {
    const shared = this.reads.latest(provider.id);
    if (!shared) {
      return null;
    }
    const news = shared.publishedAt > provider.state.adoptedAt;
    if (shared.retryAt && shared.retryAt.getTime() > Date.now()) {
      // Provider credentials and rate limits are shared across windows.
      if (provider.state.hold?.statedAt !== shared.retryAt.getTime()) {
        this.hold(provider, shared.retryAt);
      }
    } else if (news) {
      // A newer publication without a retry deadline proves that a read completed after the hold.
      this.releaseHold(provider);
    }
    if (news) {
      provider.state.adoptedAt = shared.publishedAt;
      provider.state.view = mergeView(provider.state.view, shared.view);
      this.paint(provider);
    }
    return shared;
  }

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

  private stopIfIdle(provider: Provider): void {
    const { usedAt } = provider.state;
    if (provider.stop && usedAt !== null && Date.now() - usedAt > IDLE_STOP_MS) {
      provider.state.usedAt = null;
      provider.stop();
    }
  }

  /**
   * Rate-limit text is overlaid at render time so it disappears with the hold. The absolute retry
   * time remains stable across redraws.
   */
  private paint(provider: Provider): void {
    const view = provider.state.view ?? { snapshot: null, message: null };
    const { hold } = provider.state;
    const held = hold && hold.until.getTime() > Date.now();
    provider.display.render(
      held
        ? {
            ...view,
            // Keep one sentence so the tooltip does not interpret the retry time as user advice.
            message: `Rate limited, retrying at ${formatMoment(hold.until, this.configuration.locale)}.`,
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
      : { snapshot: null, message: result.message, verbatim: result.verbatim },
  );
}
