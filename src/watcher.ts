import { existsSync, watch, type FSWatcher } from "node:fs";
import type { ProviderWatcher } from "./usage-bar";

const RETRY_DELAY_MS = 15_000;
/**
 * Missing directories and persistent watcher failures look alike here, so retries back off to a
 * ceiling instead of giving up or retrying continuously.
 */
const MAX_RETRY_DELAY_MS = 10 * 60_000;
const CHANGE_DEBOUNCE_MS = 5_000;
/**
 * Per-window jitter spreads the same filesystem event before `ReadCoordinator` resolves any
 * remaining claim collisions.
 */
const CHANGE_JITTER_MS = 2_000;

export interface WatchTarget {
  directory: string;
  fileSuffix: string;
  recursive: boolean;
}

/**
 * Both targets mean the reading is due again, but only the second one requires the provider itself
 * to be replaced first.
 */
export function watchBoth(
  activity: ProviderWatcher,
  credentials: ProviderWatcher,
  onCredentialsChange: () => void,
): ProviderWatcher {
  return {
    start: (onChange) => {
      activity.start(onChange);
      credentials.start(() => {
        onCredentialsChange();
        onChange();
      });
    },
    stop: () => {
      activity.stop();
      credentials.stop();
    },
    dispose: () => {
      activity.dispose();
      credentials.dispose();
    },
  };
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private onChange: (() => void) | null = null;
  private retryDelayMs: number;

  constructor(
    private readonly target: WatchTarget,
    private readonly debounceMs: number = CHANGE_DEBOUNCE_MS + Math.random() * CHANGE_JITTER_MS,
    private readonly baseRetryDelayMs: number = RETRY_DELAY_MS,
  ) {
    this.retryDelayMs = baseRetryDelayMs;
  }

  start(onChange: () => void): void {
    this.stop();
    this.retryDelayMs = this.baseRetryDelayMs;
    this.onChange = onChange;
    this.open();
  }

  stop(): void {
    this.onChange = null;
    this.closeWatcher();
    this.retryTimer = clearTimer(this.retryTimer);
    this.debounceTimer = clearTimer(this.debounceTimer);
  }

  dispose(): void {
    this.stop();
  }

  private open(): void {
    const { target } = this;
    if (!this.onChange) {
      return;
    }
    // Linux may return a silent watcher for a missing path instead of throwing, so check first to
    // guarantee that retry is armed everywhere. The catch still covers removal between calls.
    if (!existsSync(target.directory)) {
      this.scheduleRetry();
      return;
    }
    try {
      this.watcher = watch(
        target.directory,
        { recursive: target.recursive, persistent: false },
        (_event, fileName) => {
          if (!fileName || fileName.endsWith(target.fileSuffix)) {
            this.scheduleChange();
          }
        },
      );
      this.watcher.on("error", () => this.scheduleRetry());
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleChange(): void {
    this.debounceTimer = clearTimer(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange?.();
    }, this.debounceMs);
  }

  private scheduleRetry(): void {
    this.closeWatcher();
    if (!this.onChange || this.retryTimer) {
      return;
    }
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer) {
    clearTimeout(timer);
  }
  return null;
}
