import { expect, test } from "vitest";
import { codexSample } from "../src/codex-history";

/**
 * Codex has moved the weekly window between `primary` and `secondary` across versions, and both
 * shapes are still on disk. Selecting by name would silently truncate the history at the release
 * that swapped them, so the duration decides.
 */

function line(rateLimits: unknown, timestamp = "2026-08-10T09:00:00.000Z"): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: rateLimits },
  });
}

const WEEKLY = { used_percent: 42, window_minutes: 10_080, resets_at: 1_787_220_180 };
const SESSION = { used_percent: 7, window_minutes: 300, resets_at: 1_787_220_180 };

test("the weekly window is read from the newer shape, where it is primary", () => {
  expect(codexSample(line({ primary: WEEKLY, secondary: null }))).toEqual({
    at: Date.parse("2026-08-10T09:00:00.000Z"),
    usedPercent: 42,
  });
});

test("the weekly window is read from the older shape, where it is secondary", () => {
  expect(codexSample(line({ primary: SESSION, secondary: WEEKLY }))?.usedPercent).toBe(42);
});

test("a reading with only a session window is not a daily total", () => {
  expect(codexSample(line({ primary: SESSION, secondary: null }))).toBeNull();
});

test("lines without limits, and lines that are not JSON, are skipped", () => {
  expect(
    codexSample(JSON.stringify({ timestamp: "2026-08-10T09:00:00Z", type: "message" })),
  ).toBeNull();
  expect(codexSample('{"rate_limits": broken')).toBeNull();
  expect(codexSample("")).toBeNull();
});

test("a percentage or timestamp outside its range is not taken", () => {
  expect(codexSample(line({ primary: { ...WEEKLY, used_percent: 140 } }))).toBeNull();
  expect(codexSample(line({ primary: { ...WEEKLY, used_percent: null } }))).toBeNull();
  expect(codexSample(line({ primary: WEEKLY }, "not a date"))).toBeNull();
});
