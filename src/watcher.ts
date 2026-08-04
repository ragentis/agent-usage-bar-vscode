import { watch, type FSWatcher } from "node:fs";

const RETRY_DELAY_MS = 15_000;
/**
 * Watching can fail for something that will pass — the agent has not run yet, so its directory is
 * not there — or for something that will not: recursive watching costs one inotify handle per
 * directory, and a machine at its limit will refuse every attempt. The two are indistinguishable
 * from here, so the wait doubles up to a ceiling rather than giving up on a directory that may yet
 * appear or retrying forever at full price.
 */
const MAX_RETRY_DELAY_MS = 10 * 60_000;
const CHANGE_DEBOUNCE_MS = 5_000;
/**
 * Every window watches the same directory and sees the same write in the same millisecond, so
 * without a spread they would all decide to read at once and no shared lease could tell their
 * arrivals apart. Drawn once per watcher, which is once per window.
 */
const CHANGE_JITTER_MS = 2_000;

export interface WatchTarget {
  directory: string;
  fileSuffix: string;
  recursive: boolean;
}

/**
 * Reports settled bursts of writes to matching files.
 * Retries quietly because a provider directory may not exist until that agent first runs.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** Doubles as the record of whether this is running: there is nothing to watch for without it. */
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
    // Reset only here: a run of failures backs off monotonically, and a fresh start is the one
    // signal that the answer might have changed for a reason other than waiting.
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
