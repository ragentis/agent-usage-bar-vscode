import { expect, test } from "vitest";
import { parseRateLimitsResponse } from "../src/codex-appserver";

const fetchedAt = new Date("2026-08-02T12:12:53.681Z");

/** Shaped after a live `account/rateLimits/read` reply on a weekly-only plan. */
const response = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1786215418 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitResetCredits: { availableCount: 1, credits: [] },
};

test("classifies by window duration rather than by primary or secondary position", () => {
  const snapshot = parseRateLimitsResponse(response, fetchedAt);
  // `primary` is the weekly bucket here; reading it as a session window would be wrong.
  expect(snapshot?.windows.map(({ kind, usedPercent }) => ({ kind, usedPercent }))).toEqual([
    { kind: "weekly", usedPercent: 7 },
  ]);
  expect(snapshot?.windows[0]?.resetsAt?.toISOString()).toBe("2026-08-08T18:56:58.000Z");
  expect(snapshot).toMatchObject({ source: "codex-app-server", plan: "plus" });
});

test("orders both windows when the plan carries a session bucket too", () => {
  const snapshot = parseRateLimitsResponse(
    {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1786215418 },
        secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1786300000 },
      },
    },
    fetchedAt,
  );
  expect(snapshot?.windows.map(({ kind, usedPercent }) => ({ kind, usedPercent }))).toEqual([
    { kind: "session", usedPercent: 25 },
    { kind: "weekly", usedPercent: 41 },
  ]);
});

test("reports available reset credits and a usable balance", () => {
  expect(parseRateLimitsResponse(response, fetchedAt)?.credits).toBe("1 reset credit");
  expect(
    parseRateLimitsResponse(
      {
        rateLimits: { ...response.rateLimits, credits: { hasCredits: true, balance: "12.50" } },
        rateLimitResetCredits: { availableCount: 2 },
      },
      fetchedAt,
    )?.credits,
  ).toBe("12.50 · 2 reset credits");
  expect(
    parseRateLimitsResponse({ rateLimits: response.rateLimits }, fetchedAt)?.credits,
  ).toBeNull();
});

test("surfaces a stopped account", () => {
  expect(
    parseRateLimitsResponse(
      { rateLimits: { ...response.rateLimits, spendControlReached: true } },
      fetchedAt,
    )?.blocked,
  ).toBe("Spend control reached");
  expect(
    parseRateLimitsResponse(
      { rateLimits: { ...response.rateLimits, rateLimitReachedType: "rate_limit_reached" } },
      fetchedAt,
    )?.blocked,
  ).toBe("Rate limit reached: rate_limit_reached");
});

test("rejects a reply that carries no usable window", () => {
  expect(
    parseRateLimitsResponse({ rateLimits: { primary: null, secondary: null } }, fetchedAt),
  ).toBeNull();
  expect(
    parseRateLimitsResponse({ rateLimits: { primary: { usedPercent: 140 } } }, fetchedAt),
  ).toBeNull();
  expect(parseRateLimitsResponse({}, fetchedAt)).toBeNull();
  expect(parseRateLimitsResponse("not an object", fetchedAt)).toBeNull();
});
