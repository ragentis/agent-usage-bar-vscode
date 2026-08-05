import { expect, test } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import type { UsageSnapshot } from "../src/usage";
import { buildStatusText, formatMoment, formatRemaining, pickSeverity } from "../src/formatting";

const now = new Date("2026-08-01T10:00:00Z");
const snapshot: UsageSnapshot = {
  windows: [
    { kind: "session", usedPercent: 12.4, resetsAt: new Date("2026-08-01T13:12:00Z") },
    { kind: "weekly", usedPercent: 41, resetsAt: new Date("2026-08-03T15:00:00Z") },
  ],
  plan: "plus",
  blocked: null,
  credits: null,
  fetchedAt: now,
  source: "claude-account-api",
};

function configure(overrides: Partial<ExtensionConfiguration> = {}): ExtensionConfiguration {
  return {
    displayMode: "compact",
    percentageMode: "used",
    showPace: true,
    warningThreshold: 80,
    errorThreshold: 95,
    codexEnabled: true,
    claudeEnabled: true,
    claudeLabel: "",
    codexLabel: "",
    refreshIntervalSeconds: 300,
    ...overrides,
  };
}

test("formats compact and full status bar text", () => {
  expect(buildStatusText(snapshot, configure(), now)).toBe("5h 12% (3h 12m)");
  expect(buildStatusText(snapshot, configure({ displayMode: "full" }), now)).toBe(
    "5h 12% (3h 12m) · 7d 41% (2d 5h)",
  );
  expect(buildStatusText(snapshot, configure({ percentageMode: "remaining" }), now)).toBe(
    "5h 88% left (3h 12m)",
  );
});

test("compact mode shows the window that triggers the warning color", () => {
  expect(buildStatusText(snapshot, configure({ warningThreshold: 40 }), now)).toBe(
    "7d 41% (2d 5h)",
  );
});

test("formats reset countdown boundaries", () => {
  expect(formatRemaining(new Date("2026-08-01T10:45:00Z"), now)).toBe("45m");
  expect(formatRemaining(new Date("2026-08-01T09:59:00Z"), now)).toBe("reset due");
  expect(formatRemaining(null, now)).toBeNull();
});

/**
 * A retry is stated as the moment it happens, not as the time until it does. The seconds of a
 * countdown would be a new tooltip every tick, and a tooltip that changes is a hover the workbench
 * closes and does not reopen — the same rule the window resets are drawn under.
 */
test("a retry states the moment it comes due, to the minute", () => {
  const moment = new Date("2026-08-01T10:00:45Z");

  expect(formatMoment(moment)).toBe(
    moment.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  );
  // Nothing of the second survives, so every drawing between two minutes says the same thing.
  expect(formatMoment(new Date("2026-08-01T10:00:01Z"))).toBe(
    formatMoment(new Date("2026-08-01T10:00:59Z")),
  );
});

test("severity always uses the original used percentage", () => {
  expect(pickSeverity(snapshot, configure({ warningThreshold: 40 }), now)).toBe("warning");
  expect(pickSeverity(snapshot, configure(), now)).toBe("normal");
});

test("a window past its reset reads as empty, marked stale, and never colored", () => {
  const expired = new Date("2026-08-01T16:00:00Z");
  expect(buildStatusText(snapshot, configure(), expired)).toBe("~5h 0%");
  expect(buildStatusText(snapshot, configure({ displayMode: "full" }), expired)).toBe(
    "~5h 0% · 7d 41% (1d 23h)",
  );
  expect(pickSeverity(snapshot, configure({ warningThreshold: 10 }), expired)).toBe("warning");
  expect(pickSeverity(snapshot, configure({ warningThreshold: 50 }), expired)).toBe("normal");
});

test("a blocked account is an error however low the percentage is", () => {
  expect(pickSeverity({ ...snapshot, blocked: "Spend control reached" }, configure(), now)).toBe(
    "error",
  );
});
