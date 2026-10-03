export const PROVIDER_IDS = ["claude", "codex", "antigravity"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

export type WindowKind = "session" | "weekly";

export type SnapshotSource = "claude-account-api" | "codex-app-server" | "antigravity-hub";

export interface UsageWindow {
  kind: WindowKind;
  usedPercent: number;
  resetsAt: Date | null;
  /** Provider duration; `pace.ts` falls back to the window kind when absent. */
  windowMinutes?: number | null;
  /** Scope narrowing the window within its kind, such as a model name. Absent means the whole kind. */
  label?: string | null;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  plan: string | null;
  /** Reason the account is stopped regardless of percentage, or null when it is running. */
  blocked: string | null;
  credits: string | null;
  /** Expiry of the soonest credit that can still be spent; the summary carries how many there are. */
  creditsExpireAt?: Date | null;
  fetchedAt: Date;
  source: SnapshotSource;
}

/** A new snapshot or the reason it is unavailable. Failures retain the last good snapshot. */
export type ProviderResult =
  | { status: "ok"; snapshot: UsageSnapshot }
  | {
      status: "unavailable";
      message: string;
      /** No request is made before this time. */
      retryAt?: Date;
      /** A refusal. Without `retryAt` the reader chooses the wait. */
      rateLimited?: boolean;
      verbatim?: boolean;
      /**
       * Nothing to run or read was found. `presence.ts` keeps it only when the agent's data
       * directory is missing too.
       */
      absent?: boolean;
    };

export type UnavailableResult = Extract<ProviderResult, { status: "unavailable" }>;

export function unavailable(message: string): UnavailableResult {
  return { status: "unavailable", message };
}

export interface ProviderView {
  snapshot: UsageSnapshot | null;
  message: string | null;
  /** Prevents provider-authored sentences from being interpreted as a cause and remedy. */
  verbatim?: boolean;
  /** The agent is not on this machine. Its item is hidden unless every agent is absent. */
  absent?: boolean;
}

export function mergeView(
  previous: ProviderView | null | undefined,
  next: ProviderView,
): ProviderView {
  return next.snapshot
    ? next
    : {
        snapshot: previous?.snapshot ?? null,
        message: next.message,
        verbatim: next.verbatim,
        absent: next.absent,
      };
}

/**
 * Caps external retry delays so a bad value cannot suppress reads indefinitely or overflow
 * `setTimeout`.
 */
export const MAX_RETRY_WAIT_MS = 60 * 60_000;

export function cappedRetryAt(retryAt: Date, now = new Date()): Date {
  const cap = now.getTime() + MAX_RETRY_WAIT_MS;
  return retryAt.getTime() > cap ? new Date(cap) : retryAt;
}

const SESSION_WINDOW_MAX_MINUTES = 360;

export function classifyWindow(windowMinutes: unknown, fallback: WindowKind): WindowKind {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return fallback;
  }
  return windowMinutes <= SESSION_WINDOW_MAX_MINUTES ? "session" : "weekly";
}

const CLOCK_TOLERANCE_MS = 2 * 60_000;
const DRIFT_TOLERANCE_MS = 10_000;

interface DatedReset {
  resetsAt: number;
  fetchedAt: number;
}

/**
 * Codex and Antigravity date a window that has not started a full window length after the request,
 * so the date moves with every read. A date that moved as far as the time between two readings is
 * such a date. The first reading has nothing to compare with, so it is judged against the local
 * clock instead.
 */
function unstarted(
  window: UsageWindow,
  read: DatedReset,
  earlier: DatedReset | undefined,
): boolean {
  const elapsed = earlier ? read.fetchedAt - earlier.fetchedAt : 0;
  // An earlier date that has passed belongs to a window that ended, so it cannot be compared.
  if (earlier && earlier.resetsAt > read.fetchedAt && elapsed > DRIFT_TOLERANCE_MS) {
    return Math.abs(read.resetsAt - earlier.resetsAt - elapsed) <= DRIFT_TOLERANCE_MS;
  }
  return window.windowMinutes
    ? read.resetsAt >= read.fetchedAt + window.windowMinutes * 60_000 - CLOCK_TOLERANCE_MS
    : false;
}

/** Remembers one provider's last reset dates, so the next reading can tell which of them move. */
export class UnstartedWindows {
  private previous = new Map<string, DatedReset>();

  /** Removes the reset date of every unused window that has not started. */
  withoutRollingResets(snapshot: UsageSnapshot): UsageSnapshot {
    const fetchedAt = snapshot.fetchedAt.getTime();
    const current = new Map<string, DatedReset>();
    const windows = snapshot.windows.map((window) => {
      if (!window.resetsAt) {
        return window;
      }
      const key = `${window.kind}:${window.label ?? ""}`;
      const read = { resetsAt: window.resetsAt.getTime(), fetchedAt };
      current.set(key, read);
      return window.usedPercent === 0 && unstarted(window, read, this.previous.get(key))
        ? { ...window, resetsAt: null }
        : window;
    });
    this.previous = current;
    return { ...snapshot, windows };
  }
}

/**
 * Sorted by kind, then unscoped before scoped. Scoped windows are ordered by percentage; unscoped
 * ones keep their original order.
 */
export function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  const order: Record<WindowKind, number> = { session: 0, weekly: 1 };
  const scoped = (window: UsageWindow): number => (window.label ? 1 : 0);
  return windows.toSorted(
    (left, right) =>
      order[left.kind] - order[right.kind] ||
      scoped(left) - scoped(right) ||
      (scoped(left) ? right.usedPercent - left.usedPercent : 0),
  );
}
