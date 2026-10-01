import { PINNED_CLI_VERSION } from "./claude-cli-version";
import {
  hasExpired,
  noSignInMessage,
  readClaudeCredentials,
  type CredentialSource,
} from "./claude-credentials";
import {
  cappedRetryAt,
  sortWindows,
  unavailable,
  type ProviderResult,
  type UsageSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./usage";
import { isRecord, validDate, validLabel, validUsedPercent } from "./validation";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const RESETS_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Accepts both standard `Retry-After` forms. A missing or non-future value, including the
 * `Retry-After: 0` this service sends, means no stated wait: retrying immediately would loop, so
 * the reader backs off on its own. Valid waits are capped.
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
 * before the unscoped one does. Unnamed scopes are merged into one window that shows the highest
 * percentage among them.
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

function extraUsageSummary(value: Record<string, unknown>): string | null {
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

/** Only an unpaused grant with resets left before its end date can still be used. */
export function parseLimitResets(
  value: unknown,
  now: Date,
): { count: number; expiresAt: Date | null } {
  const block = isRecord(value) && value.eligible === true ? value : null;
  const grants = block && Array.isArray(block.grants) ? block.grants : [];
  let count = 0;
  let expiresAt: Date | null = null;
  for (const grant of grants) {
    if (!isRecord(grant) || grant.paused === true) {
      continue;
    }
    const left = grant.resets_left;
    const endsAt = validDate(grant.ends_at);
    if (typeof left !== "number" || !Number.isInteger(left) || left <= 0) {
      continue;
    }
    if (endsAt && endsAt.getTime() <= now.getTime()) {
      continue;
    }
    count += left;
    if (endsAt && (!expiresAt || endsAt.getTime() < expiresAt.getTime())) {
      expiresAt = endsAt;
    }
  }
  return { count, expiresAt };
}

function credits(
  value: Record<string, unknown>,
  now: Date,
): { summary: string | null; expiresAt: Date | null } {
  const resets = parseLimitResets(value.cedar_ember, now);
  const available =
    resets.count > 0 ? `${resets.count} limit reset${resets.count === 1 ? "" : "s"}` : null;
  return {
    summary:
      [extraUsageSummary(value), available].filter((part) => part !== null).join(" · ") || null,
    expiresAt: available ? resets.expiresAt : null,
  };
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
  const { summary, expiresAt } = credits(value, fetchedAt);
  return {
    windows,
    plan,
    blocked: blockedReason(value),
    credits: summary,
    creditsExpireAt: expiresAt,
    fetchedAt,
    source: "claude-account-api",
  };
}

/** Set once the service has refused the reset request but answered the plain one. */
export interface UsageRequestState {
  plainOnly: boolean;
}

/**
 * A refused reset request falls back to the plain request, so a refusal can remove the resets line
 * but not the reading.
 */
function isResetRefusal(status: number): boolean {
  return status === 400 || status === 403;
}

export async function fetchClaudeUsage(
  sources?: readonly CredentialSource[],
  cliVersion: string = PINNED_CLI_VERSION,
  state: UsageRequestState = { plainOnly: false },
): Promise<ProviderResult> {
  const credentials = await readClaudeCredentials(sources);
  if (!credentials) {
    return {
      status: "unavailable",
      message: noSignInMessage(),
      absent: true,
    };
  }
  if (hasExpired(credentials)) {
    return unavailable("The Claude Code sign-in has expired. Run Claude Code to renew it.");
  }

  const send = (withResets: boolean): Promise<Response> =>
    fetch(withResets ? RESETS_URL : USAGE_URL, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        ...(withResets ? { "User-Agent": `claude-cli/${cliVersion} (external, cli)` } : {}),
      },
      // Refuse redirects so the token only reaches the host the bundle audit pins.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response: Response;
  try {
    response = await send(!state.plainOnly);
    if (!state.plainOnly && isResetRefusal(response.status)) {
      response = await send(false);
      state.plainOnly = response.ok;
    }
  } catch {
    // The message never carries the thrown error, which can quote the request headers.
    return unavailable("The usage service could not be reached.");
  }

  if (response.status === 401 || response.status === 403) {
    return unavailable("Claude Code is no longer signed in. Run Claude Code to renew it.");
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
    return unavailable(`The usage service answered ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return unavailable("The usage response could not be read.");
  }

  const snapshot = parseClaudeUsageResponse(payload, credentials.plan, new Date());
  return snapshot ? { status: "ok", snapshot } : unavailable("The usage response held no windows.");
}
