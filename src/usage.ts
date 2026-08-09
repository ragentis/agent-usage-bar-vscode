export type ProviderId = "claude" | "codex";
export type WindowKind = "session" | "weekly";

/** Account-wide source of a usage reading. */
export type SnapshotSource = "claude-account-api" | "codex-app-server";

export interface UsageWindow {
  kind: WindowKind;
  usedPercent: number;
  resetsAt: Date | null;
  /** Provider-supplied duration used by `pace.ts`; the window kind supplies a fallback. */
  windowMinutes?: number | null;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  plan: string | null;
  /** Reason the account is stopped regardless of percentage, or null when it is running. */
  blocked: string | null;
  credits: string | null;
  fetchedAt: Date;
  source: SnapshotSource;
}

/**
 * A new snapshot or the reason it is unavailable. Failures retain the last good snapshot;
 * `retryAt` additionally prevents another request before the provider's stated time.
 */
export type ProviderResult =
  | { status: "ok"; snapshot: UsageSnapshot }
  | { status: "unavailable"; message: string; retryAt?: Date; verbatim?: boolean };

/** Latest usable snapshot and, when present, the reason it could not be refreshed. */
export interface ProviderView {
  snapshot: UsageSnapshot | null;
  message: string | null;
  /** Prevents provider-authored sentences from being interpreted as a cause and remedy. */
  verbatim?: boolean;
}

/** Retains the last good snapshot when a local or shared refresh fails. */
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
      };
}

const SESSION_WINDOW_MAX_MINUTES = 360;
const MAX_LABEL_LENGTH = 80;

/** Storage bound; tooltip layout applies its own shorter display limit. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Caps an external retry delay at the longest configurable refresh interval. This prevents a bad
 * value from suppressing reads indefinitely and stays well below `setTimeout` overflow behavior.
 */
export const MAX_RETRY_WAIT_MS = 60 * 60_000;

/** Applies the retry cap to provider responses and waits adopted from another window. */
export function cappedRetryAt(retryAt: Date, now = new Date()): Date {
  const cap = now.getTime() + MAX_RETRY_WAIT_MS;
  return retryAt.getTime() > cap ? new Date(cap) : retryAt;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validUsedPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

/** Rejects durations beyond the supported monthly upper bound. */
const MAX_WINDOW_MINUTES = 31 * 24 * 60;

export function validWindowMinutes(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_WINDOW_MINUTES
    ? value
    : null;
}

/** Accepts an ISO string or a Unix timestamp in seconds, which is what both providers emit. */
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

/** Validates sentence-length messages independently from the shorter label limit. */
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

export function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  const order: Record<WindowKind, number> = { session: 0, weekly: 1 };
  return windows.toSorted((left, right) => order[left.kind] - order[right.kind]);
}
