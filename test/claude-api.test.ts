import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  fetchClaudeUsage,
  parseClaudeUsageResponse,
  parseRetryAfter,
  parseUsageLimits,
} from "../src/claude-api";
import { fileSource } from "../src/claude-credentials";
import { MAX_RETRY_WAIT_MS, type ProviderResult } from "../src/usage";

const fetchedAt = new Date("2026-08-02T11:36:00Z");

/** Shaped after a live response, including the buckets the account does not use. */
const response = {
  five_hour: { utilization: 7, resets_at: "2026-08-02T16:29:59.048107+00:00" },
  seven_day: { utilization: 9, resets_at: "2026-08-04T08:59:59.048130+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, spend_limit_reached: false },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 7,
      severity: "normal",
      resets_at: "2026-08-02T16:29:59.048107+00:00",
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 9,
      severity: "normal",
      resets_at: "2026-08-04T08:59:59.048130+00:00",
      is_active: true,
    },
  ],
};

test("reads the normalized limits array", () => {
  const windows = parseUsageLimits(response);
  expect(windows.map(({ kind, usedPercent }) => ({ kind, usedPercent }))).toEqual([
    { kind: "session", usedPercent: 7 },
    { kind: "weekly", usedPercent: 9 },
  ]);
  expect(windows[0]?.resetsAt?.toISOString()).toBe("2026-08-02T16:29:59.048Z");
});

test("keeps the fullest bucket when the account carries several weekly scopes", () => {
  const windows = parseUsageLimits({
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 9, resets_at: "2026-08-04T08:59:59Z" },
      { kind: "weekly_opus", group: "weekly", percent: 62, resets_at: "2026-08-05T08:59:59Z" },
      { kind: "weekly_sonnet", group: "weekly", percent: 3, resets_at: "2026-08-04T08:59:59Z" },
    ],
  });
  expect(windows).toHaveLength(1);
  expect(windows[0]?.usedPercent).toBe(62);
  expect(windows[0]?.resetsAt?.toISOString()).toBe("2026-08-05T08:59:59.000Z");
});

test("falls back to kind when group is missing and drops unknown scopes", () => {
  const windows = parseUsageLimits({
    limits: [
      { kind: "session", percent: 4 },
      { kind: "weekly_all", percent: 11 },
      { kind: "monthly_experiment", percent: 90 },
      { kind: "weekly_all", percent: "not a number" },
      "not an object",
    ],
  });
  expect(windows.map(({ kind, usedPercent }) => ({ kind, usedPercent }))).toEqual([
    { kind: "session", usedPercent: 4 },
    { kind: "weekly", usedPercent: 11 },
  ]);
});

test("returns no windows for a payload without a usable limits array", () => {
  expect(parseUsageLimits({ limits: [] })).toEqual([]);
  expect(parseUsageLimits({ five_hour: { utilization: 7 } })).toEqual([]);
  expect(parseUsageLimits("not an object")).toEqual([]);
});

test("builds a snapshot tagged with the account source", () => {
  expect(parseClaudeUsageResponse(response, "pro", fetchedAt)).toMatchObject({
    source: "claude-account-api",
    plan: "pro",
    blocked: null,
    credits: null,
    fetchedAt,
  });
});

test("reports a stopped account and enabled extra usage", () => {
  const blocked = parseClaudeUsageResponse(
    { ...response, extra_usage: { is_enabled: true, spend_limit_reached: true, utilization: 48 } },
    null,
    fetchedAt,
  );
  expect(blocked?.blocked).toBe("Extra usage spend limit reached");
  expect(blocked?.credits).toBe("48% of extra usage");

  const spent = parseClaudeUsageResponse(
    { ...response, spend: { severity: "exhausted" } },
    null,
    fetchedAt,
  );
  expect(spent?.blocked).toBe("Spend limit reached");
});

test("rejects a response that carries no recognized window", () => {
  expect(parseClaudeUsageResponse({ limits: [] }, "pro", fetchedAt)).toBeNull();
  expect(parseClaudeUsageResponse("not an object", "pro", fetchedAt)).toBeNull();
});

test("reads Retry-After in both of its documented forms", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  expect(parseRetryAfter("90", now)?.toISOString()).toBe("2026-08-03T12:01:30.000Z");
  expect(parseRetryAfter("Mon, 03 Aug 2026 12:05:00 GMT", now)?.toISOString()).toBe(
    "2026-08-03T12:05:00.000Z",
  );
  // A missing or unusable header must read as "unknown", never as "retry now".
  expect(parseRetryAfter(null, now)).toBeNull();
  expect(parseRetryAfter("", now)).toBeNull();
  expect(parseRetryAfter("soon", now)).toBeNull();
  expect(parseRetryAfter("-30", now)).toBeNull();
});

/**
 * What this service actually answers a refusal with, observed against the live endpoint. Read
 * literally it is a wait of nothing: the hold it would set has expired before it is stored, so no
 * window ever waits and the next read earns the same refusal. Unknown is the truthful reading, and
 * it is the reading the caller has a wait of its own for.
 */
test("a wait that is already over is no statement of a wait at all", () => {
  const now = new Date("2026-08-03T12:00:00Z");

  expect(parseRetryAfter("0", now)).toBeNull();
  expect(parseRetryAfter("Mon, 03 Aug 2026 11:59:59 GMT", now)).toBeNull();
  // A second either side of the line, so the boundary is the one being tested.
  expect(parseRetryAfter("1", now)?.toISOString()).toBe("2026-08-03T12:00:01.000Z");
});

test("a wait longer than the cap is shortened to it rather than taken at its word", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  const capped = new Date(now.getTime() + MAX_RETRY_WAIT_MS).toISOString();

  // Both forms, because both are published to the other windows and become a timer in each, and a
  // timer this far out silently fires at once instead of waiting.
  expect(parseRetryAfter(String(10 ** 9), now)?.toISOString()).toBe(capped);
  expect(parseRetryAfter("Sat, 03 Aug 2030 12:00:00 GMT", now)?.toISOString()).toBe(capped);
  // A wait inside the cap is passed through exactly as stated.
  expect(parseRetryAfter(String(MAX_RETRY_WAIT_MS / 1_000 - 1), now)?.toISOString()).toBe(
    new Date(now.getTime() + MAX_RETRY_WAIT_MS - 1_000).toISOString(),
  );
});

/**
 * `fetchClaudeUsage` is where the token is actually spent, and the one place a promise the README
 * makes can be checked rather than read: one host, three headers, no redirect. Everything below it
 * is parsing, tested above; everything around it is the five different things it can say instead of
 * a number.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const signedInDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    signedInDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function signedIn(expiresAt: number = Date.now() + 3_600_000) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-usage-"));
  signedInDirectories.push(directory);
  await fs.writeFile(
    path.join(directory, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "secret-token", expiresAt, subscriptionType: "max" },
    }),
    "utf8",
  );
  return [fileSource(directory)];
}

/** Enough of a `Response` for the branches under test, which read four things off it. */
function answered(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () =>
      body === undefined ? Promise.reject(new Error("unexpected token")) : Promise.resolve(body),
  };
}

/** Stands in for the service and records exactly what it was asked. An `Error` is the request not
 *  arriving at all; anything else is what came back. */
function service(reply: unknown): { url: unknown; init: Record<string, unknown> }[] {
  const calls: { url: unknown; init: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", (url: unknown, init: Record<string, unknown>) => {
    calls.push({ url, init });
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  return calls;
}

/** Narrows, so the wait and the words can be read off a result rather than asserted around. */
function refusal(result: ProviderResult): { message: string; retryAt?: Date } {
  if (result.status !== "unavailable") {
    throw new Error(`expected no reading, got ${result.status}`);
  }
  return result;
}

test("the token goes to the one pinned endpoint, and carries nothing else with it", async () => {
  const calls = service(answered(200, response));

  const result = await fetchClaudeUsage(await signedIn());

  expect(result).toMatchObject({ status: "ok" });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(USAGE_URL);
  // Stated exactly rather than by containment: an extra header is the thing worth failing over.
  expect(calls[0]?.init.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer secret-token",
    "anthropic-beta": "oauth-2025-04-20",
  });
  // A followed redirect would carry the token to a host the bundle audit never sees.
  expect(calls[0]?.init.redirect).toBe("error");
  expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
});

test("the plan comes from the sign-in, which is the only place it is stated", async () => {
  service(answered(200, response));

  const result = await fetchClaudeUsage(await signedIn());

  expect(result).toMatchObject({ status: "ok", snapshot: { plan: "max" } });
});

test("a refusal carries the wait as a moment, not as words that go stale", async () => {
  service(answered(429, {}, { "retry-after": "45" }));
  const before = Date.now();

  const result = refusal(await fetchClaudeUsage(await signedIn()));

  expect(result.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 45_000);
  // The countdown belongs to whoever draws it; written in here it would be the number the refusal
  // was born with, still on screen long after the wait it describes had run out.
  expect(result.message).not.toMatch(/\d/);
});

test("a refusal naming no window is held for a minute rather than retried at once", async () => {
  service(answered(429, {}));
  const before = Date.now();

  const result = refusal(await fetchClaudeUsage(await signedIn()));

  expect(result.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 60_000);
});

test("each way the service can decline says which one it was", async () => {
  service(answered(401, {}));
  expect(refusal(await fetchClaudeUsage(await signedIn())).message).toMatch(/no longer signed in/);

  service(answered(500, {}));
  expect(refusal(await fetchClaudeUsage(await signedIn())).message).toMatch(/answered 500/);

  service(answered(200, undefined));
  expect(refusal(await fetchClaudeUsage(await signedIn())).message).toMatch(/could not be parsed/);

  service(answered(200, { limits: [] }));
  expect(refusal(await fetchClaudeUsage(await signedIn())).message).toMatch(/no known windows/);

  // None of these carries a wait: only the service naming one produces a wait.
  service(answered(500, {}));
  expect(refusal(await fetchClaudeUsage(await signedIn())).retryAt).toBeUndefined();
});

test("a request that never arrives never quotes what it was carrying", async () => {
  service(new Error(`connect ECONNREFUSED with Authorization: Bearer secret-token`));

  const result = refusal(await fetchClaudeUsage(await signedIn()));

  expect(result.message).toBe("The Claude usage service could not be reached.");
  expect(result.message).not.toMatch(/secret-token/);
});

test("a sign-in that cannot work is not spent on a request", async () => {
  const calls = service(answered(200, response));

  const expired = refusal(await fetchClaudeUsage(await signedIn(Date.now() - 1)));
  expect(expired.message).toMatch(/expired/);

  const missing = refusal(
    await fetchClaudeUsage([fileSource(await fs.mkdtemp(path.join(os.tmpdir(), "empty-")))]),
  );
  expect(missing.message).toMatch(/No Claude Code sign-in/);

  expect(calls).toHaveLength(0);
});
