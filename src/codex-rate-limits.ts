import { classifyWindow, sortWindows, type UsageSnapshot, type UsageWindow } from "./usage";
import {
  isRecord,
  validDate,
  validLabel,
  validUsedPercent,
  validWindowMinutes,
} from "./validation";

function creditBalance(value: unknown): string | null {
  if (!isRecord(value) || value.hasCredits !== true) {
    return null;
  }
  if (value.unlimited === true) {
    return "unlimited";
  }
  return typeof value.balance === "number" && Number.isFinite(value.balance)
    ? String(value.balance)
    : validLabel(value.balance);
}

function blockedReason(
  rateLimits: Record<string, unknown>,
  windows: readonly UsageWindow[],
): string | null {
  if (rateLimits.spendControlReached === true) {
    return "Spend control reached";
  }
  // A full window already explains the stop, so the notice only covers a limit no window shows.
  if (windows.some((window) => window.usedPercent >= 100)) {
    return null;
  }
  // The reached-type values are backend-defined, so the raw label is surfaced rather than guessed at.
  const reached = validLabel(rateLimits.rateLimitReachedType);
  return reached ? `Rate limit reached: ${reached}` : null;
}

function parseWindow(value: unknown, fallback: "session" | "weekly"): UsageWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = validUsedPercent(value.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  // Never trust primary to mean "session": on a weekly-only plan primary is the weekly window.
  return {
    kind: classifyWindow(value.windowDurationMins, fallback),
    usedPercent,
    resetsAt: validDate(value.resetsAt),
    windowMinutes: validWindowMinutes(value.windowDurationMins),
  };
}

/** Only an available credit can still be spent, so a spent or lapsed grant must not set the date. */
function nearestExpiry(resetCredits: Record<string, unknown>, now: Date): Date | null {
  if (!Array.isArray(resetCredits.credits)) {
    return null;
  }
  const expiries = resetCredits.credits
    .map((credit: unknown) =>
      isRecord(credit) && credit.status === "available" ? validDate(credit.expiresAt) : null,
    )
    .filter((expiry) => expiry !== null)
    .map((expiry) => expiry.getTime())
    .filter((expiry) => expiry > now.getTime());
  return expiries.length === 0 ? null : new Date(Math.min(...expiries));
}

function parseCredits(
  rateLimits: Record<string, unknown>,
  value: unknown,
  now: Date,
): { summary: string | null; expiresAt: Date | null } {
  const balance = creditBalance(rateLimits.credits);
  const resetCredits = isRecord(value) ? value : null;
  const count = typeof resetCredits?.availableCount === "number" ? resetCredits.availableCount : 0;
  const available = count > 0 ? `${count} reset credit${count === 1 ? "" : "s"}` : null;
  return {
    summary: [balance, available].filter((part) => part !== null).join(" · ") || null,
    expiresAt: resetCredits && available ? nearestExpiry(resetCredits, now) : null,
  };
}

export function parseRateLimitsResponse(value: unknown, fetchedAt: Date): UsageSnapshot | null {
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    return null;
  }
  const rateLimits = value.rateLimits;
  const windows = sortWindows(
    [
      parseWindow(rateLimits.primary, "session"),
      parseWindow(rateLimits.secondary, "weekly"),
    ].filter((window) => window !== null),
  );
  if (windows.length === 0) {
    return null;
  }
  const credits = parseCredits(rateLimits, value.rateLimitResetCredits, fetchedAt);
  return {
    windows,
    plan: validLabel(rateLimits.planType),
    blocked: blockedReason(rateLimits, windows),
    credits: credits.summary,
    creditsExpireAt: credits.expiresAt,
    fetchedAt,
    source: "codex-app-server",
  };
}
