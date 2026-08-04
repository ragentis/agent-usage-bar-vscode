import { expect, test } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import { buildTooltipLines, escapeMarkdown } from "../src/tooltip";
import type { UsageSnapshot } from "../src/usage";

/**
 * The tooltip is the far end of the only path in this extension that carries someone else's text to
 * the screen: a plan name, a stop reason, a credit balance, and the message from a failed read all
 * come from a service or from another window's stored entry. It is rendered as markdown with theme
 * icons enabled, which makes every one of them a chance to draw something that was never a reading.
 */

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

/** As `status-bar.ts` joins them, which is the string the renderer is actually handed. */
function tooltip(
  reading: Partial<UsageSnapshot> = {},
  failure: string | null = null,
  overrides: Partial<ExtensionConfiguration> = {},
  age: string | null = null,
): string {
  return buildTooltipLines(
    "Claude Code usage",
    { ...snapshot, ...reading },
    configure(overrides),
    failure,
    age,
    now,
  ).join("\n\n");
}

test("a reading is drawn as a title, a line per window, and where it came from", () => {
  const lines = buildTooltipLines("Claude Code usage", snapshot, configure(), null, null, now);

  expect(lines[0]).toBe("**Claude Code usage** · Plan: plus");
  // The reset moment itself is a local date in the reader's own locale, so what is stated here is
  // everything up to it; that it is escaped on the way in is the next test's business.
  expect(lines[1]).toMatch(/^5-hour: ▰▱▱▱▱▱▱▱▱▱ \*\*12%\*\* used · resets 3h 12m \(.+\)$/);
  expect(lines[2]).toMatch(/^Weekly: ▰▰▰▰▱▱▱▱▱▱ \*\*41%\*\* used · resets 2d 5h \(.+\)$/);
  expect(lines.at(-1)).toMatch(/^From Claude account · as of /);
  // Nothing optional was set, so nothing optional was drawn.
  expect(lines).toHaveLength(4);
});

test("nothing a provider says can arrive as markup or as an icon", () => {
  // Every field below is a string the extension did not write. `command:` is the one that matters
  // most: a trusted markdown link to it runs the command, and `isTrusted` being false is the only
  // other thing standing in the way. Escaping is what makes that a belt as well as braces.
  const payload = "$(error) **pwn** [x](command:workbench.action.quit) <img> `code`";
  const text = tooltip({ plan: payload, blocked: payload, credits: payload }, payload);

  expect(text).not.toContain("$(error)");
  expect(text).not.toContain("**pwn**");
  expect(text).not.toContain("](command:");
  expect(text).not.toContain("<img>");
  expect(text).not.toContain("`code`");
  // Escaped rather than stripped: the user still gets to read what the service said.
  expect(text).toContain("pwn");
  expect(text).toContain("workbench");
  // And the one codicon that belongs there, which the extension wrote itself, still renders.
  expect(text).toContain("$(warning) Last refresh failed:");
});

test("the escaping covers every character markdown gives a meaning to", () => {
  expect(escapeMarkdown("a-b.c!d")).toBe("a\\-b\\.c\\!d");
  expect(escapeMarkdown("|table|")).toBe("\\|table\\|");
  expect(escapeMarkdown("~~struck~~")).toBe("\\~\\~struck\\~\\~");
  // A backslash of its own, so an escape cannot be escaped away by the value itself.
  expect(escapeMarkdown("\\*not bold\\*")).toBe("\\\\\\*not bold\\\\\\*");
  expect(escapeMarkdown("plain text 42")).toBe("plain text 42");
});

test("the meter fills in tenths and never overflows its ten cells", () => {
  const cells = (usedPercent: number): string => {
    const line = tooltip({ windows: [{ kind: "session", usedPercent, resetsAt: null }] }).split(
      "\n",
    )[2];
    return line?.split(" ")[1] ?? "";
  };

  expect(cells(0)).toBe("▱▱▱▱▱▱▱▱▱▱");
  expect(cells(100)).toBe("▰▰▰▰▰▰▰▰▰▰");
  // Rounded, not floored: half a cell used is a cell shown, and 4% is not yet one.
  expect(cells(4)).toBe("▱▱▱▱▱▱▱▱▱▱");
  expect(cells(5)).toBe("▰▱▱▱▱▱▱▱▱▱");
  expect(cells(99)).toBe("▰▰▰▰▰▰▰▰▰▰");
});

test("each optional line appears only when there is something to say", () => {
  expect(tooltip()).not.toContain("Credits:");
  expect(tooltip()).not.toContain("Last refresh failed");
  expect(tooltip({ plan: null })).toContain("**Claude Code usage**\n");
  expect(tooltip({ plan: null })).not.toContain("Plan:");

  const stopped = tooltip({ blocked: "Spend limit reached", credits: "3 reset credits" });
  // The stop reason is the second line, above the numbers it makes irrelevant.
  expect(stopped.split("\n\n")[1]).toBe("**Spend limit reached**");
  expect(stopped).toContain("Credits: 3 reset credits");
});

test("a window past its reset says so instead of showing a stale number", () => {
  const later = new Date("2026-08-01T16:00:00Z");
  const text = buildTooltipLines(
    "Claude Code usage",
    snapshot,
    configure(),
    null,
    null,
    later,
  ).join("\n\n");

  expect(text).toContain("5-hour: ▱▱▱▱▱▱▱▱▱▱ **0%** used · reset since this reading");
  // The note is what explains the `~` the status bar text is showing at the same moment.
  expect(text).toContain("marks a window assumed empty after its reset");
  // Only the window that actually reset: the weekly one still counts down.
  expect(text).toMatch(/Weekly: .*\*\*41%\*\* used · resets 1d 23h/);
});

test("the percentage mode the item uses is the one the tooltip explains", () => {
  const text = tooltip({}, null, { percentageMode: "remaining" });

  expect(text).toContain("**88%** remaining");
  expect(text).toContain("**59%** remaining");
  expect(text).not.toContain(" used");
});

test("an age is stated beside the reading it belongs to, not on its own", () => {
  expect(tooltip({}, null, {}, "2h ago")).toMatch(/From Claude account · as of .+ \(2h ago\)$/);
  expect(tooltip()).not.toContain("ago)");
});

test("a Codex reading names Codex as where it came from", () => {
  expect(tooltip({ source: "codex-app-server" })).toContain("From Codex account · as of ");
});
