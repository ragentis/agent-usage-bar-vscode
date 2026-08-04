import {
  hasExpired,
  noSignInMessage,
  readClaudeCredentials,
  type CredentialSource,
} from "./claude-credentials";
import {
  cappedRetryAt,
  isRecord,
  sortWindows,
  validDate,
  validUsedPercent,
  type ProviderResult,
  type UsageSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./usage";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;

/**
 * `Retry-After` is either a delta in seconds or an HTTP date, and the endpoint is undocumented, so
 * both forms are accepted. Null says the service rate limits without stating for how long, which
 * leaves the caller to assume a wait. The result is capped before it is passed on, because it is
 * republished to the other windows and becomes a timer in each.
 *
 * A moment that is not in the future is read as no statement at all. This service answers a refusal
 * with `Retry-After: 0`, and a wait of nothing is not a wait: taken at its word it would set a hold
 * that has already expired, which is a refusal nobody waits out and a second refusal on the next
 * read. The same holds for a date already past.
 */
export function parseRetryAfter(header: string | null, now: Date): Date | null {
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  const stated =
    trimmed !== "" && Number.isFinite(seconds)
      ? new Date(now.getTime() + seconds * 1000)
      : new Date(trimmed);
  return Number.isNaN(stated.getTime()) || stated.getTime() <= now.getTime()
    ? null
    : cappedRetryAt(stated, now);
}

function windowKind(entry: Record<string, unknown>): WindowKind | null {
  // `group` is the stable axis; `kind` carries the finer scope such as weekly_opus.
  const group = typeof entry.group === "string" ? entry.group : null;
  if (group === "session" || group === "weekly") {
    return group;
  }
  const kind = typeof entry.kind === "string" ? entry.kind : null;
  if (kind === "session") {
    return "session";
  }
  return kind?.startsWith("weekly") ? "weekly" : null;
}

/**
 * The account can carry several weekly buckets at once (overall, Opus, Sonnet). The status bar
 * shows one number per kind, so the fullest bucket wins: that is the one that stops work first.
 */
export function parseUsageLimits(value: unknown): UsageWindow[] {
  if (!isRecord(value) || !Array.isArray(value.limits)) {
    return [];
  }
  const byKind = new Map<WindowKind, UsageWindow>();
  for (const entry of value.limits) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = windowKind(entry);
    const usedPercent = validUsedPercent(entry.percent);
    if (!kind || usedPercent === null) {
      continue;
    }
    const existing = byKind.get(kind);
    if (!existing || usedPercent > existing.usedPercent) {
      byKind.set(kind, { kind, usedPercent, resetsAt: validDate(entry.resets_at) });
    }
  }
  return sortWindows([...byKind.values()]);
}

function blockedReason(value: Record<string, unknown>): string | null {
  const extra = isRecord(value.extra_usage) ? value.extra_usage : null;
  if (extra?.spend_limit_reached === true) {
    return "Extra usage spend limit reached";
  }
  return isRecord(value.spend) && value.spend.severity === "exhausted"
    ? "Spend limit reached"
    : null;
}

function creditSummary(value: Record<string, unknown>): string | null {
  const extra = isRecord(value.extra_usage) ? value.extra_usage : null;
  if (!extra || extra.is_enabled !== true) {
    return null;
  }
  const utilization = validUsedPercent(extra.utilization);
  if (utilization !== null) {
    return `${Math.round(utilization)}% of extra usage`;
  }
  return typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits)
    ? `${extra.used_credits} used`
    : null;
}

export function parseClaudeUsageResponse(
  value: unknown,
  plan: string | null,
  fetchedAt: Date,
): UsageSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const windows = parseUsageLimits(value);
  if (windows.length === 0) {
    return null;
  }
  return {
    windows,
    plan,
    blocked: blockedReason(value),
    credits: creditSummary(value),
    fetchedAt,
    source: "claude-account-api",
  };
}

export async function fetchClaudeUsage(
  sources?: readonly CredentialSource[],
): Promise<ProviderResult> {
  const credentials = await readClaudeCredentials(sources);
  if (!credentials) {
    return {
      status: "unavailable",
      message: noSignInMessage(),
    };
  }
  if (hasExpired(credentials)) {
    return {
      status: "unavailable",
      message: "The Claude Code sign-in has expired; run Claude Code to renew it",
    };
  }

  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
      },
      // The bundle audit pins the one URL this extension may call, and a followed redirect would
      // reach a second host without ever appearing in the bundle. Refusing them keeps the audit
      // an honest description of where the token can travel.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The message never carries the thrown error, which can quote the request headers.
    return { status: "unavailable", message: "The Claude usage service could not be reached" };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "unavailable",
      message: "Claude Code is no longer signed in; run Claude Code to renew it",
    };
  }
  if (response.status === 429) {
    const now = new Date();
    // Without a stated window the wait is a guess, and a minute is short enough to stay responsive
    // while still being long enough to stop a watcher-triggered burst from making things worse.
    const retryAt =
      parseRetryAfter(response.headers.get("retry-after"), now) ??
      new Date(now.getTime() + RATE_LIMIT_FALLBACK_MS);
    // No countdown in the message: `retryAt` carries the wait and `UsageBar.paint` states the time
    // left at draw time.
    return {
      status: "unavailable",
      message: "The Claude usage service is rate limiting requests",
      retryAt,
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      message: `The Claude usage service answered ${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", message: "The Claude usage response could not be parsed" };
  }

  const snapshot = parseClaudeUsageResponse(payload, credentials.plan, new Date());
  return snapshot
    ? { status: "ok", snapshot }
    : { status: "unavailable", message: "The Claude usage response held no recognized windows" };
}
