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
    locale: undefined,
    showPace: true,
    warningThreshold: 80,
    errorThreshold: 95,
    warnWhen: "threshold",
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

const scoped: UsageSnapshot = {
  ...snapshot,
  windows: [
    ...snapshot.windows,
    {
      kind: "weekly",
      usedPercent: 62,
      resetsAt: new Date("2026-08-03T15:00:00Z"),
      label: "Fable",
    },
  ],
};

test("a quiet scoped window stays out of the status bar and names itself once it is loud", () => {
  expect(buildStatusText(scoped, configure({ displayMode: "full" }), now)).toBe(
    "5h 12% (3h 12m) · 7d 41% (2d 5h)",
  );
  expect(
    buildStatusText(scoped, configure({ displayMode: "full", warningThreshold: 60 }), now),
  ).toBe("5h 12% (3h 12m) · 7d 41% (2d 5h) · 7d Fable 62% (2d 5h)");
});

test("compact mode swaps to the scoped window that drives the color", () => {
  expect(buildStatusText(scoped, configure({ warningThreshold: 60 }), now)).toBe(
    "7d Fable 62% (2d 5h)",
  );
});

test("formats reset countdown boundaries", () => {
  expect(formatRemaining(new Date("2026-08-01T10:45:00Z"), now)).toBe("45m");
  expect(formatRemaining(new Date("2026-08-01T09:59:00Z"), now)).toBe("reset due");
  expect(formatRemaining(null, now)).toBeNull();
});

test("a retry states the moment it comes due, to the minute", () => {
  const moment = new Date("2026-08-01T10:00:45Z");

  expect(formatMoment(moment)).toBe(
    moment.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  );
  expect(formatMoment(new Date("2026-08-01T10:00:01Z"))).toBe(
    formatMoment(new Date("2026-08-01T10:00:59Z")),
  );
});

test("a configured locale decides how a moment is written", () => {
  const moment = new Date("2026-08-01T18:56:00Z");
  const at = (locale: string): string => formatMoment(moment, locale);

  expect(at("en-US-u-hc-h23")).toBe(at("en-GB-u-hc-h23"));
  expect(at("en-US-u-hc-h23")).not.toBe(at("en-US-u-hc-h12"));
  expect(at("en-US-u-hc-h12")).toMatch(/(AM|PM)/);
  expect(at("en-US-u-hc-h23")).not.toMatch(/(AM|PM)/);
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

const WEEK_MINUTES = 10_080;

function weekly(usedPercent: number, elapsedPercent: number): UsageSnapshot {
  const remaining = WEEK_MINUTES * (1 - elapsedPercent / 100);
  return {
    ...snapshot,
    windows: [
      { kind: "session", usedPercent: 22, resetsAt: new Date("2026-08-01T13:12:00Z") },
      { kind: "weekly", usedPercent, resetsAt: new Date(now.getTime() + remaining * 60_000) },
    ],
  };
}

test("a window still inside its own pace raises neither the warning nor the swap", () => {
  const paced = weekly(80, 90);
  const setting = configure({ warnWhen: "overPace" });

  expect(pickSeverity(paced, configure(), now)).toBe("warning");
  expect(buildStatusText(paced, configure(), now)).toBe("7d 80% (16h 48m)");
  expect(pickSeverity(paced, setting, now)).toBe("normal");
  expect(buildStatusText(paced, setting, now)).toBe("5h 22% (3h 12m)");
});

test("the same percentage reached far too early still warns and still takes the item", () => {
  const early = weekly(80, 50);
  const setting = configure({ warnWhen: "overPace" });

  expect(pickSeverity(early, setting, now)).toBe("warning");
  expect(buildStatusText(early, setting, now)).toBe("7d 80% (3d 12h)");
});

test("a nearly empty window is an error at any pace", () => {
  const spent = weekly(96, 99);
  const setting = configure({ warnWhen: "overPace" });

  expect(pickSeverity(spent, setting, now)).toBe("error");
  expect(buildStatusText(spent, setting, now)).toBe("7d 96% (1h 40m)");
});

test("a blocked account is an error however low the percentage is", () => {
  expect(pickSeverity({ ...snapshot, blocked: "Spend control reached" }, configure(), now)).toBe(
    "error",
  );
});
