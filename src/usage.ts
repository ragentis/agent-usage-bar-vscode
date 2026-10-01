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

/** How Node reports a program or path that does not exist. */
export function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
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

const SESSION_WINDOW_MAX_MINUTES = 360;
const MAX_LABEL_LENGTH = 80;

const MAX_MESSAGE_LENGTH = 500;

/**
 * Caps external retry delays so a bad value cannot suppress reads indefinitely or overflow
 * `setTimeout`.
 */
export const MAX_RETRY_WAIT_MS = 60 * 60_000;

export function cappedRetryAt(retryAt: Date, now = new Date()): Date {
  const cap = now.getTime() + MAX_RETRY_WAIT_MS;
  return retryAt.getTime() > cap ? new Date(cap) : retryAt;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function validUsedPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

const MAX_WINDOW_MINUTES = 31 * 24 * 60;

export function validWindowMinutes(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_WINDOW_MINUTES
    ? value
    : null;
}

export function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function validLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_LABEL_LENGTH ? trimmed : null;
}

export function validMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : null;
}

export function classifyWindow(windowMinutes: unknown, fallback: WindowKind): WindowKind {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return fallback;
  }
  return windowMinutes <= SESSION_WINDOW_MAX_MINUTES ? "session" : "weekly";
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
