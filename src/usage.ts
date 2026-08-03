export type ProviderId = "claude" | "codex";
export type WindowKind = "session" | "weekly";

/** Where a reading came from. Both describe the whole subscription across every device. */
export type SnapshotSource = "claude-account-api" | "codex-app-server";

export interface UsageWindow {
  kind: WindowKind;
  usedPercent: number;
  resetsAt: Date | null;
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
 * Either a reading or the reason there is none. Every reason is handled alike — the last good
 * numbers stay on screen with their age — so nothing is gained by sorting them into kinds. The one
 * distinction that changes what happens next is carried by `retryAt`, set when the service named a
 * moment before which another call is pointless.
 */
export type ProviderResult =
  | { status: "ok"; snapshot: UsageSnapshot }
  | { status: "unavailable"; message: string; retryAt?: Date };

/** What the status bar currently knows: the newest usable snapshot, plus why it is not newer. */
export interface ProviderView {
  snapshot: UsageSnapshot | null;
  message: string | null;
}

/**
 * A failed read never discards a good one. Showing the last known numbers with their age beats
 * blanking the item, because usage does not vanish when the network hiccups — and the rule holds
 * whoever the reader was, so a window adopting another's result applies it the same way.
 */
export function mergeView(
  previous: ProviderView | null | undefined,
  next: ProviderView,
): ProviderView {
  return next.snapshot ? next : { snapshot: previous?.snapshot ?? null, message: next.message };
}

const SESSION_WINDOW_MAX_MINUTES = 360;
const MAX_LABEL_LENGTH = 80;

/**
 * The longest wait this extension will sit out before asking again. A service that names a longer
 * one is not contradicted — it is simply asked once more at the cap, which costs at most one
 * refused request an hour and is what keeps a stated wait from outliving every window that heard
 * it. It also has to be capped somewhere: `setTimeout` cannot represent more than about twenty-five
 * days and fires at once instead of saying so, which turns an absurd wait into a busy loop rather
 * than a long one. An hour matches the longest configurable refresh interval, past which a wait and
 * a stall look the same from the status bar.
 */
export const MAX_RETRY_WAIT_MS = 60 * 60_000;

/** Applied wherever a wait enters from outside: the response header, and another window's entry. */
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
