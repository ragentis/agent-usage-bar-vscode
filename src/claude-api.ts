import * as fs from "node:fs/promises";
import * as path from "node:path";
import { claudeDirectory } from "./claude";
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

const CREDENTIALS_FILE = ".credentials.json";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const MAX_CREDENTIALS_BYTES = 64 * 1024;

interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number | null;
  plan: string | null;
}

/**
 * Reads the token Claude Code already holds. Refreshing it is deliberately not implemented:
 * a refresh rotates the stored token, so racing Claude Code for it would sign the user out
 * of their own CLI. An expired token is reported as unavailable and left for Claude Code.
 */
export async function readClaudeCredentials(
  directory = claudeDirectory(),
): Promise<ClaudeCredentials | null> {
  const credentialsPath = path.join(directory, CREDENTIALS_FILE);
  let raw: string;
  try {
    // `lstat`, so a symlink is described rather than followed: only a real file here is read.
    const file = await fs.lstat(credentialsPath);
    if (!file.isFile() || file.size > MAX_CREDENTIALS_BYTES) {
      return null;
    }
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.claudeAiOauth)) {
    return null;
  }
  const oauth = payload.claudeAiOauth;
  if (typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    return null;
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt:
      typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
        ? oauth.expiresAt
        : null,
    plan: validLabel(oauth.subscriptionType),
  };
}

/**
 * `Retry-After` comes as either a delta in seconds or an HTTP date, and the endpoint is not
 * documented, so neither form is assumed. A null answer is itself a finding: it says the service
 * rate limits without telling us for how long. Whatever comes back is capped before it is passed
 * on, because this value is also published to the other windows and becomes a timer in each.
 */
export function parseRetryAfter(header: string | null, now: Date): Date | null {
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return cappedRetryAt(new Date(now.getTime() + seconds * 1000), now);
  }
  const absolute = new Date(trimmed);
  return Number.isNaN(absolute.getTime()) ? null : cappedRetryAt(absolute, now);
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

export async function fetchClaudeUsage(directory = claudeDirectory()): Promise<ProviderResult> {
  const credentials = await readClaudeCredentials(directory);
  if (!credentials) {
    return {
      status: "unavailable",
      message: "No Claude Code sign-in was found; run Claude Code once",
    };
  }
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) {
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
    // No countdown in the message: `retryAt` carries the wait, and whoever draws it states the
    // time left now. Written in here it would be the number the refusal was born with, still on
    // screen long after the wait it describes had run out.
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
