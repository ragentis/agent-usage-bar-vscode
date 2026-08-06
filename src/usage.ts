export type ProviderId = "claude" | "codex";
export type WindowKind = "session" | "weekly";

/** Where a reading came from. Both describe the whole subscription across every device. */
export type SnapshotSource = "claude-account-api" | "codex-app-server";

export interface UsageWindow {
  kind: WindowKind;
  usedPercent: number;
  resetsAt: Date | null;
  /**
   * How long the window runs, when the provider says. Absent is the ordinary case — only Codex
   * states it — and `pace.ts`, the one reader, falls back to the length the kind implies. It is
   * kept rather than only classified with because the moment a window opened is `resetsAt` less
   * this, and a pace measured from the wrong moment is a wrong pace stated confidently.
   */
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
 * Either a reading or the reason there is none. Every reason is handled alike — the last good
 * numbers stay on screen with their age — so they are not sorted into kinds. The one distinction
 * that changes what happens next is `retryAt`, set when the service named a moment before which
 * another call is pointless.
 */
export type ProviderResult =
  | { status: "ok"; snapshot: UsageSnapshot }
  | { status: "unavailable"; message: string; retryAt?: Date; verbatim?: boolean };

/** What the status bar currently knows: the newest usable snapshot, plus why it is not newer. */
export interface ProviderView {
  snapshot: UsageSnapshot | null;
  message: string | null;
  /**
   * True when the message is a provider's own words. What is written here is written to one shape —
   * a statement, then at most one thing to do about it — which the tooltip reads back out of the
   * sentences. Words from elsewhere were never written to it, so what looks like a remedy in them
   * is only whatever came after the first stop; marked, they are drawn rather than read.
   */
  verbatim?: boolean;
}

/**
 * A failed read never discards a good one: usage does not vanish when the network hiccups, so the
 * last known numbers stay on screen with their age. The rule holds whoever read, so a window
 * adopting another's result applies it the same way.
 */
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

/**
 * Not a width: the tooltip cuts a message to the lines it draws, which are well inside this. What
 * is refused here is only a value long enough that storing it is the problem.
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * The longest wait this extension will sit out before asking again. A service naming a longer one
 * is asked once more at the cap, which costs at most one refused request an hour and keeps a stated
 * wait from outliving every window that heard it. It has to be capped somewhere in any case:
 * `setTimeout` cannot represent more than about twenty-five days and fires at once instead of
 * saying so, turning an absurd wait into a busy loop. An hour matches the longest configurable
 * refresh interval, past which a wait and a stall look the same from the status bar.
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

/** A month, past which a stated window length is not a window this extension knows how to read. */
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

/**
 * A message is not a label. A label is a word or two beside a number — a plan, a balance — and is
 * refused when it is longer, since a value that long was never the thing it claims to be. A message
 * is a sentence and then some, and how much of it fits is the tooltip's business, not this one's.
 */
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
