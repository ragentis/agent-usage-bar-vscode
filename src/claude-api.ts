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
  validLabel,
  validUsedPercent,
  type ProviderResult,
  type UsageSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./usage";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Accepts both standard `Retry-After` forms. Missing or non-future values, including the service's
 * observed `Retry-After: 0`, mean no stated wait; treating zero as immediate retry would create a
 * refusal loop; the reader backs off on its own instead. Valid waits are capped before becoming
 * shared timers.
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

/** A window may be narrowed to one model; the display name is the only part meant to be shown. */
function scopeLabel(entry: Record<string, unknown>): string | null {
  const scope = isRecord(entry.scope) ? entry.scope : null;
  return scope && isRecord(scope.model) ? validLabel(scope.model.display_name) : null;
}

/**
 * A named scope, such as a per-model weekly limit, becomes its own window because it can stop work
 * before the unscoped one does. Scopes the service does not name collapse into a single window
 * holding the fullest of them, which is the most an unlabelled row can honestly claim.
 */
export function parseUsageLimits(value: unknown): UsageWindow[] {
  if (!isRecord(value) || !Array.isArray(value.limits)) {
    return [];
  }
  const byScope = new Map<string, UsageWindow>();
  for (const entry of value.limits) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = windowKind(entry);
    const usedPercent = validUsedPercent(entry.percent);
    if (!kind || usedPercent === null) {
      continue;
    }
    const label = scopeLabel(entry);
    const key = label ? `${kind}:${label}` : kind;
    const existing = byScope.get(key);
    if (!existing || usedPercent > existing.usedPercent) {
      byScope.set(key, { kind, usedPercent, resetsAt: validDate(entry.resets_at), label });
    }
  }
  return sortWindows([...byScope.values()]);
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
      message: "The Claude Code sign-in has expired. Run Claude Code to renew it.",
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
      // Refuse redirects so the bundle audit remains an honest bound on where the token can travel.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The message never carries the thrown error, which can quote the request headers.
    return { status: "unavailable", message: "The usage service could not be reached." };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "unavailable",
      message: "Claude Code is no longer signed in. Run Claude Code to renew it.",
    };
  }
  if (response.status === 429) {
    // `retryAt` carries the wait; embedding it in the message would leave stale countdown text.
    const retryAt = parseRetryAfter(response.headers.get("retry-after"), new Date());
    return {
      status: "unavailable",
      message: "Rate limited by the usage service.",
      rateLimited: true,
      ...(retryAt ? { retryAt } : {}),
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      message: `The usage service answered ${response.status}.`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", message: "The usage response could not be read." };
  }

  const snapshot = parseClaudeUsageResponse(payload, credentials.plan, new Date());
  return snapshot
    ? { status: "ok", snapshot }
    : { status: "unavailable", message: "The usage response held no windows." };
}
