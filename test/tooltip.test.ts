import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import { HISTORY_LEVELS, localDay, shiftDay, type DailyTotals } from "../src/history";
import { buildMessageTooltip, buildTooltip, escapeHtml, TOOLTIP_COMMANDS } from "../src/tooltip";
import { isRecord, type UsageSnapshot } from "../src/usage";

/**
 * Provider text crosses a trusted-Markdown boundary here. Tests pin escaping and the renderer's
 * HTML allowlist so external values cannot become markup, icons, or commands.
 */

const now = new Date("2026-08-01T10:00:00Z");

const ALLOWED_STYLE =
  /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/;

const ALLOWED_TAGS = new Set([
  "div",
  "hr",
  "br",
  "b",
  "span",
  "small",
  "h1",
  "h3",
  "h6",
  "p",
  "a",
  "table",
  "tr",
  "td",
]);

const STEP = "<table><tr><td></td></tr></table>";

const COLUMNS = 52;

/** The bar is drawn in this many cells; `tooltip.ts` measures the same number against the text. */
const BAR_CELLS = 314;

const ROW_COLUMNS = 60;

const INDENT = "&nbsp;&nbsp;";

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
    showHistory: true,
    theme: "dark",
    ...overrides,
  };
}

function tooltip(
  reading: Partial<UsageSnapshot> = {},
  failure: string | null = null,
  overrides: Partial<ExtensionConfiguration> = {},
  age: string | null = null,
  history: DailyTotals | null = null,
): string {
  return buildTooltip(
    "Claude Code usage",
    "agent-usage-bar-claude",
    { ...snapshot, ...reading },
    configure(overrides),
    failure === null ? null : { message: failure },
    age,
    now,
    history,
  );
}

/** Days are local, so the fixture is built from the clock the tooltip will read rather than pinned. */
const today = localDay(now);

const history: DailyTotals = {
  unit: "percent",
  days: { [shiftDay(today, -2)]: 20, [today]: 5 },
};

function verbatimTooltip(failure: string): string {
  return buildTooltip(
    "Claude Code usage",
    "agent-usage-bar-claude",
    snapshot,
    configure(),
    { message: failure, verbatim: true },
    null,
    now,
  );
}

function tooltipAt(moment: Date): string {
  return buildTooltip(
    "Claude Code usage",
    "agent-usage-bar-claude",
    snapshot,
    configure(),
    null,
    null,
    moment,
  );
}

function heading(kind: string, percent: string): RegExp {
  return new RegExp(
    `<h3>${INDENT}<span style="color:[^"]+">${kind}</span>${INDENT}${percent} <small>`,
  );
}

function windowBlock(text: string, kind: "5-hour" | "Weekly"): string {
  return text.split(/<h6>&nbsp;<\/h6>|<hr>/).find((part) => part.includes(`>${kind}</span>`)) ?? "";
}

const INDENT_WIDTH = 2;

const CHARACTERS: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#40;": "(",
  "&#41;": ")",
};

/**
 * Extracts visible text lines while treating table cells as separate aligned runs.
 */
function drawnLines(text: string): string[] {
  return (
    text
      // A table opens its own block, so it begins a line as surely as a break does.
      .split(/<br>|<\/?h[1-6]>|<\/?p>|<hr>|<\/?div>|<table[^>]*>|<\/td>/)
      .map((part) =>
        part
          .replace(/<[^>]+>/g, "")
          // The mark stands in a bar, which is cells rather than text and is dropped as blank below.
          .replace(/\$\(agent-usage-bar-mark(-halo)?\)/g, "")
          // A codicon is written as its name and drawn as one glyph, so it is counted as one.
          .replace(/\$\([a-z0-9-]+\)/g, "@")
          .replace(/&[a-z]+;|&#\d+;/g, (entity) => CHARACTERS[entity] ?? entity),
      )
      .filter((part) => part.trim())
  );
}

/** The drawn row of days: what stands between the step under the title and the legend under it. */
function stripBlock(text: string): string {
  const block = text.slice(text.indexOf("Daily activity"));
  const start = block.indexOf(`<div>${STEP}`);
  const end = block.indexOf('<table width="100%">');
  return start === -1 || end === -1 ? "" : block.slice(start + `<div>${STEP}`.length, end);
}

/** Named rather than numbered; the reason is pinned by its own test below. */
const STEP_NAMES = ["none", "one", "two", "three", "four", "five"];

const STRIP_DAY = /<span style="color:([^"]+);">\$\(agent-usage-bar-day-([a-z]+)\)<\/span>/g;

/** The drawn strip, one entry per day and oldest first. */
function stripDays(text: string): { step: number; color: string }[] {
  return [...stripBlock(text).matchAll(STRIP_DAY)].map(([, color, name]) => ({
    step: STEP_NAMES.indexOf(name ?? ""),
    color: color ?? "",
  }));
}

/** The mark is its halo glyph and then its own, each in a span that sets only a color. */
const MARK =
  '<span style="color:([^;"]+);">\\$\\(agent-usage-bar-mark-halo\\)</span>' +
  '<span style="color:([^;"]+);">\\$\\(agent-usage-bar-mark\\)</span>';

/** The cells the mark glyph's advance width replaces; see `MARK_CELLS` in the tooltip. */
const MARK_WIDTH = 3;

const RUN = `(?:&nbsp;|${MARK.replaceAll('([^;"]+)', '[^;"]+')})*`;

const BAR = new RegExp(
  `<span style="background-color:([^;]+);border-radius:4px;">` +
    `(?:<span style="background-color:([^;]+);border-radius:4px;">(${RUN})</span>)?(${RUN})</span>`,
);

/** Cells in a run, counting the mark as the cells it stands in for. */
function count(part: string | undefined): number {
  const marks = new RegExp(MARK).test(part ?? "") ? MARK_WIDTH : 0;
  return (part?.match(/&nbsp;/g) ?? []).length + marks;
}

/** Locates the mark by the cells drawn before it, so its position is read as one bar-wide index. */
function mark(fill: string, rest: string): { at: number | null; color: string; halo: string } {
  for (const [part, offset] of [
    [fill, 0],
    [rest, count(fill)],
  ] as const) {
    const found = new RegExp(MARK).exec(part);
    if (found) {
      return {
        at: count(part.slice(0, found.index)) + offset,
        color: found[2] ?? "",
        halo: found[1] ?? "",
      };
    }
  }
  return { at: null, color: "", halo: "" };
}

interface Bar {
  filled: number;
  track: number;
  fillColor: string;
  mark: number | null;
  markColor: string;
  haloColor: string;
}

function cells(text: string): Bar {
  const bar = BAR.exec(text);
  const fill = bar?.[3] ?? "";
  const rest = bar?.[4] ?? "";
  const found = mark(fill, rest);
  return {
    filled: count(fill),
    track: count(rest),
    fillColor: bar?.[2] ?? "",
    mark: found.at,
    markColor: found.color,
    haloColor: found.halo,
  };
}

test("a reading is drawn as a header, a block per window, and where it came from", () => {
  const text = tooltip();

  expect(text.startsWith("<div>")).toBe(true);
  expect(text.endsWith("</div>")).toBe(true);
  expect(text.startsWith("<div><h1></h1>")).toBe(true);
  expect(text.endsWith("<h1></h1></div>")).toBe(true);
  expect(text).toContain(`<p></p><hr><h6></h6>${STEP}`);
  expect(text).toContain(`<p></p>${STEP}<hr><h1></h1>`);
  expect(text).toContain(`${INDENT}$(agent-usage-bar-claude) <b>Claude Code usage</b>`);
  expect(text).toContain("· plus");
  const session = windowBlock(text, "5-hour");
  expect(session).toMatch(heading("5-hour", "12%"));
  expect(session).toContain(">used<");
  // The title closes its heading, and the bar and its legend share the block that follows.
  expect(session).not.toContain("<br>");
  expect(session).toMatch(
    new RegExp(`</h3><div><small>.+<table width="100%"><tr><td>${INDENT}<span [^>]*>Resets .+`),
  );
  expect(session.endsWith("</table></div>")).toBe(true);
  expect(text).toContain("From Claude account · as of ");
  expect(text.indexOf("Refresh")).toBeGreaterThan(text.indexOf("From Claude account"));
});

test("the whole tooltip is one html block with no blank line in it", () => {
  const text = tooltip({ plan: "a\n\nb", credits: "c\n\nd" }, "e\n\nf");

  expect(text).not.toContain("\n");
  // One wrapper plus one per window, since a bar and its legend share a block of their own.
  expect(text.match(/<div>/g)).toHaveLength(1 + snapshot.windows.length);
  expect(text.match(/<\/div>/g)).toHaveLength(1 + snapshot.windows.length);
  expect(text).toContain("a b");
  expect(text).toContain("e f");
});

test("nothing on the tooltip moves between one reading and the next", () => {
  expect(tooltipAt(new Date(now.getTime() + 47 * 60_000))).toBe(tooltipAt(now));
  expect(tooltipAt(now)).not.toMatch(/\d+h \d+m/);
});

test("no line of text is wider than the bar, however much a provider says", () => {
  const message =
    "The Claude Code sign-in has expired and nothing here will renew one on its own account";
  const text = tooltip({ plan: "a plan name of quite unreasonable length for a plan" }, message);

  for (const line of drawnLines(text)) {
    expect(line.length).toBeLessThanOrEqual(COLUMNS + INDENT_WIDTH);
  }
  expect(drawnLines(text).join(" ").replace(/\s+/g, " ")).toContain(message);
  expect(text.match(/<br>&nbsp;&nbsp;/g)?.length).toBeGreaterThan(1);

  const failure = drawnLines(
    tooltip(
      {},
      "The Claude Code sign-in has expired. Run Claude Code to renew it, then refresh this reading.",
    ),
  ).filter((line) => line.includes("Last refresh failed") || line.includes("to renew it"));
  expect(failure).toHaveLength(2);
  expect(failure[1]?.length).toBeGreaterThan(COLUMNS + INDENT_WIDTH);
  for (const line of failure) {
    expect(line.length).toBeLessThanOrEqual(ROW_COLUMNS + INDENT_WIDTH);
  }
});

test("the daily strip draws one day per glyph and names the busiest of them", () => {
  const text = tooltip({}, null, {}, null, history);
  const days = stripDays(text);

  expect(text).toContain("Daily activity");
  expect(text).toContain("busiest day");
  // The busiest day sets the scale, so it is the one named beside the strip.
  expect(text).toContain("20%");
  // Thirty days whatever is recorded: two stand at a step of the ramp, twenty-eight on the floor.
  expect(days).toHaveLength(30);
  expect(days.filter((day) => day.step === 0)).toHaveLength(28);
  expect(days.filter((day) => day.step > 0)).toHaveLength(2);
});

/**
 * Height and shade are one step, and the step is the glyph. Drawing height any other way would widen
 * the day with it: a cell's width and its height both follow the one font size.
 */
test("a day's height and its shade are the same step", () => {
  const days = stripDays(tooltip({}, null, {}, null, history));

  // Twenty percent is the busiest day, so it takes the top step; five of it lands two steps down.
  expect(days.at(-3)).toEqual({ step: HISTORY_LEVELS, color: "#3794ffff" });
  expect(days.at(-1)).toEqual({ step: 2, color: "#3794ff80" });
  expect(days[0]).toEqual({ step: 0, color: "var(--vscode-editorWidget-border)" });
});

test("the light theme takes the same ramp on its own hue", () => {
  const days = stripDays(tooltip({}, null, { theme: "light" }, null, history));

  expect(days.at(-3)?.color).toBe("#1a85ffff");
  expect(days.at(-1)?.color).toBe("#1a85ff80");
});

/** The glyph carries its own width, height, gap and rounding, so the strip lays out nothing itself. */
test("the strip is glyphs between two indents, and nothing else", () => {
  const row = stripBlock(tooltip({}, null, {}, null, history));

  expect(row).not.toContain("background-color");
  expect(row).not.toContain("</span></span>");
  // Every day is a glyph, so the only cells on the row are the indent at either end.
  expect((row.match(/&nbsp;/g) ?? []).length).toBe(2 * 7);
});

function at(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : null;
}

function manifestIcons(): unknown {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as unknown;
  return at(at(manifest, "contributes"), "icons");
}

/** Every step the renderer can produce needs a glyph, or that day would draw as a missing icon. */
test("the manifest registers a glyph for every step, including the empty one", () => {
  const icons = manifestIcons();

  expect(STEP_NAMES).toHaveLength(HISTORY_LEVELS + 1);
  for (const [step, name] of STEP_NAMES.entries()) {
    expect(at(icons, `agent-usage-bar-day-${name}`)).toMatchObject({
      default: { fontCharacter: `\\E81${step}` },
    });
  }
});

test("the manifest registers the mark and its halo, which the weekly bar draws by name", () => {
  const icons = manifestIcons();

  expect(at(icons, "agent-usage-bar-mark")).toMatchObject({
    default: { fontCharacter: "\\E816" },
  });
  expect(at(icons, "agent-usage-bar-mark-halo")).toMatchObject({
    default: { fontCharacter: "\\E817" },
  });
  const drawn = [...windowBlock(tooltip(), "Weekly").matchAll(/\$\(([^)]+)\)/g)].map(
    ([, id]) => id,
  );
  expect(drawn).toEqual(["agent-usage-bar-mark-halo", "agent-usage-bar-mark"]);
});

/**
 * The renderer keeps a codicon class only when it matches this, so an id carrying a digit or a
 * capital has its class stripped and draws an empty element. Nothing reports it: the icons
 * contribution point accepts `[A-Za-z0-9]` segments, the icon registers, and its CSS rule is
 * written, so every other check passes while the glyph never appears.
 */
const SANITIZED_CLASS = /^codicon codicon-[a-z-]+( codicon-modifier-[a-z-]+)?$/;

test("every icon id survives the sanitizer that has to render it", () => {
  const icons = manifestIcons();
  const ids = Object.keys(isRecord(icons) ? icons : {});

  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(`codicon codicon-${id}`).toMatch(SANITIZED_CLASS);
  }
});

test("every glyph the strip asks for is an id the sanitizer keeps", () => {
  const drawn = [...stripBlock(tooltip({}, null, {}, null, history)).matchAll(/\$\(([^)]+)\)/g)];

  expect(drawn.length).toBe(30);
  for (const [, id] of drawn) {
    expect(`codicon codicon-${id}`).toMatch(SANITIZED_CLASS);
  }
});

function manifestFontPaths(): string[] {
  const icons = manifestIcons();
  return Object.values(isRecord(icons) ? icons : {}).map((icon) =>
    String(at(at(icon, "default"), "fontPath")),
  );
}

test("every icon points at the one font file, and it is there", () => {
  const paths = manifestFontPaths();

  expect(paths.length).toBeGreaterThan(0);
  expect(new Set(paths)).toEqual(new Set(["./assets/agent-usage-bar.woff"]));
  expect(existsSync("assets/agent-usage-bar.woff")).toBe(true);
});

/**
 * `.vscodeignore` denies everything and then allows what ships, by name. A font no allow line
 * matches is left out of the package entirely, and the extension then installs with no glyphs at
 * all rather than with one missing.
 */
test("the packaged extension carries the font the manifest names", () => {
  const allowed = readFileSync(".vscodeignore", "utf8")
    .split("\n")
    .flatMap((line) => (line.startsWith("!") ? [line.slice(1).trim()] : []));
  const shipped = (path: string): boolean =>
    allowed.some((pattern) =>
      new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("*", "[^/]*")}$`,
      ).test(path),
    );

  expect(allowed.length).toBeGreaterThan(0);
  for (const path of manifestFontPaths()) {
    expect(shipped(path.replace(/^\.\//, ""))).toBe(true);
  }
});

test("the strip is left out when there is nothing to draw or the setting is off", () => {
  expect(tooltip()).not.toContain("Daily activity");
  expect(tooltip({}, null, { showHistory: false }, null, history)).not.toContain("Daily activity");
  expect(tooltip({}, null, {}, null, { unit: "percent", days: {} })).not.toContain(
    "Daily activity",
  );
});

/** Codex counts a share of its own limit; Claude counts tokens and must never claim otherwise. */
test("each provider's strip is labelled in the unit it was measured in", () => {
  const tokens: DailyTotals = { unit: "tokens", days: { [today]: 8_400_000 } };
  expect(tooltip({}, null, {}, null, tokens)).toContain("8.4M tokens");
  expect(tooltip({}, null, {}, null, history)).not.toContain("tokens");
});

/** Width is the glyph's advance, so the count is what holds the strip to the width of the bars. */
test("the strip is thirty glyphs however many days are recorded", () => {
  const days: Record<string, number> = {};
  for (let index = 0; index < 30; index++) {
    days[shiftDay(today, -index)] = index + 1;
  }

  expect(stripDays(tooltip({}, null, {}, null, { unit: "percent", days }))).toHaveLength(30);
});

test("every element and every attribute the tooltip writes survives the renderer's allowlist", () => {
  const text = [
    tooltip({ blocked: "Spend limit reached", credits: "3 reset credits" }, "connection refused"),
    tooltip({}, null, {}, "2h ago"),
    tooltip({}, null, {}, null, history),
    tooltip({}, null, { theme: "light" }, null, history),
    buildMessageTooltip("Codex usage", "agent-usage-bar-codex", "no reading yet"),
  ].join("");

  for (const [, tag] of text.matchAll(/<\/?([a-z][a-z0-9]*)/g)) {
    expect(ALLOWED_TAGS).toContain(tag);
  }
  const attributes = [...text.matchAll(/<([a-z0-9]+) ([a-z-]+)=/g)].map(
    ([, tag, attribute]) => `${tag} ${attribute}`,
  );
  expect(new Set(attributes)).toEqual(new Set(["span style", "a href", "table width", "td align"]));
  const styles = [...text.matchAll(/<span style="([^"]*)"/g)].map(([, style]) => style);
  expect(styles.length).toBeGreaterThan(0);
  for (const style of styles) {
    expect(style).toMatch(ALLOWED_STYLE);
  }
});

test("the only links on the tooltip are its own two commands", () => {
  const links = [
    ...tooltip({ blocked: "stopped", credits: "none" }, "failed").matchAll(/href="([^"]+)"/g),
  ].map(([, target]) => target);

  expect(links).toEqual(TOOLTIP_COMMANDS.map((command) => `command:${command}`));
  expect(TOOLTIP_COMMANDS).toEqual(["agentUsageBar.refresh", "agentUsageBar.openSettings"]);
});

test("nothing a provider says can arrive as markup, as an icon, or as a command", () => {
  const payload = '$(error) <a href="command:workbench.action.quit">x</a> <span style="x">y</span>';
  const text = tooltip({ plan: payload, blocked: payload, credits: payload }, payload);

  expect(text.match(/\$\(error\)/g)).toHaveLength(1);
  expect(text.match(/\$&#40;error&#41;/g)).toHaveLength(4);
  expect(text).toContain('<span style="color:var(--vscode-charts-red);">$(error)</span>');
  expect(text).not.toContain('href="command:workbench');
  expect(text).not.toContain('<span style="x">');
  expect(text).not.toContain('<a href="command:workbench.action.quit">');
  expect(text).toContain("href=&quot;command:workbench.action.quit&quot;&gt;x&lt;/a&gt;");
  expect(text).toContain("&lt;a");
});

test("the escaping covers every character html or the icon renderer gives a meaning to", () => {
  expect(escapeHtml("<b>&amp;</b>")).toBe("&lt;b&gt;&amp;amp;&lt;/b&gt;");
  expect(escapeHtml("$(alert) and $(x)")).toBe("$&#40;alert&#41; and $&#40;x&#41;");
  expect(escapeHtml('say "hi" o\'clock')).toBe("say &quot;hi&quot; o&#39;clock");
  expect(escapeHtml("two\n\nlines\ttabbed")).toBe("two lines tabbed");
  expect(escapeHtml("**bold** [x] ~a~ 42")).toBe("**bold** [x] ~a~ 42");
});

test("the bar fills to the percent and its two segments always total a full bar", () => {
  const bar = (usedPercent: number): { filled: number; track: number } => {
    const { filled, track } = cells(
      tooltip({ windows: [{ kind: "session", usedPercent, resetsAt: null }] }),
    );
    return { filled, track };
  };

  expect(bar(0)).toEqual({ filled: 0, track: BAR_CELLS });
  expect(bar(100)).toEqual({ filled: BAR_CELLS, track: 0 });
  expect(bar(50)).toEqual({ filled: 157, track: 157 });
  expect(bar(12.4)).toEqual({ filled: 39, track: 275 });
  expect(bar(99.9)).toEqual({ filled: BAR_CELLS, track: 0 });
});

const WEEK_RESET = new Date("2026-08-03T15:00:00Z");

/** The reading is 68% of the way through this week, which is what the pace line says. */
function weekly(usedPercent: number, overrides: Partial<ExtensionConfiguration> = {}): Bar {
  const text = tooltip(
    { windows: [{ kind: "weekly", usedPercent, resetsAt: WEEK_RESET }] },
    null,
    overrides,
  );
  expect(text).toContain(
    overrides.showPace === false ? "Resets " : `${Math.round((6_900 / 10_080) * 100)}% of the week`,
  );
  return cells(windowBlock(text, "Weekly"));
}

const ELAPSED_CELLS = Math.round(0.68 * BAR_CELLS) - 1;

const MARK_COLOR = "var(--vscode-descriptionForeground)";

/** The halo is the hover's own background, so it cuts the mark out of the bar and vanishes beyond it. */
const HALO_COLOR = "var(--vscode-editorHoverWidget-background)";

test("the weekly bar marks how far the week itself has gone", () => {
  const bar = weekly(41);

  expect(bar).toMatchObject({
    filled: 129,
    mark: ELAPSED_CELLS,
    markColor: MARK_COLOR,
    haloColor: HALO_COLOR,
  });
  expect(bar.filled + bar.track).toBe(BAR_CELLS);
});

test("a mark inside the fill replaces its cells rather than adding to the bar", () => {
  const bar = weekly(90);

  expect(bar).toMatchObject({
    filled: 283,
    track: 31,
    mark: ELAPSED_CELLS,
    markColor: MARK_COLOR,
    haloColor: HALO_COLOR,
  });
});

test("the mark takes the same theme colors over a fill of any severity as over the track", () => {
  for (const usedPercent of [41, 90, 96]) {
    const bar = weekly(usedPercent);
    expect(bar.markColor).toBe(MARK_COLOR);
    expect(bar.haloColor).toBe(HALO_COLOR);
  }
  expect(weekly(90).fillColor).toBe("var(--vscode-charts-yellow)");
  expect(weekly(96).fillColor).toBe("var(--vscode-charts-red)");
});

test("a mark the fill edge already accounts for is left off", () => {
  expect(weekly(68).mark).toBeNull();
  expect(weekly(69).mark).toBeNull();
  expect(weekly(66).mark).toBe(ELAPSED_CELLS);
});

test("a mark that would fall under a rounded end is left off too", () => {
  const atElapsed = (minutes: number): number | null => {
    const resetsAt = new Date(now.getTime() + (10_080 - minutes) * 60_000);
    const text = tooltip({ windows: [{ kind: "weekly", usedPercent: 50, resetsAt }] });
    return cells(windowBlock(text, "Weekly")).mark;
  };

  expect(atElapsed(101)).toBeNull();
  expect(atElapsed(9_980)).toBeNull();
  // The mark follows the whole percentage the pace line states, not the unrounded fraction.
  expect(atElapsed(2_000)).toBe(Math.round(0.2 * BAR_CELLS) - 1);
});

test("only a clocked weekly window is marked, and only while pace is shown", () => {
  expect(weekly(41, { showPace: false }).mark).toBeNull();
  expect(cells(windowBlock(tooltip(), "5-hour")).mark).toBeNull();
  expect(
    cells(tooltip({ windows: [{ kind: "weekly", usedPercent: 41, resetsAt: null }] })).mark,
  ).toBeNull();
});

test("a bar is one rounded track with a rounded fill nested in it", () => {
  const session = windowBlock(tooltip(), "5-hour");

  expect(session).toContain(
    '<span style="background-color:var(--vscode-editorWidget-border);border-radius:4px;"><span style="background-color:var(--vscode-charts-blue);border-radius:4px;">',
  );
  // Six for the bar and the indent scaled with it, and one around the label.
  expect(session.match(/<small>/g)).toHaveLength(7);
  // The indent beside the bar is inside the scaling, so nothing on that line is taller than the bar.
  expect(session).toContain("<small><small><small><small><small><small>&nbsp;");
});

test("a bar is colored by its own window, not by the worst one on the tooltip", () => {
  const text = tooltip({
    windows: [
      { kind: "session", usedPercent: 5, resetsAt: null },
      { kind: "weekly", usedPercent: 96, resetsAt: null },
    ],
  });

  expect(cells(windowBlock(text, "5-hour")).fillColor).toBe("var(--vscode-charts-blue)");
  expect(cells(windowBlock(text, "Weekly")).fillColor).toBe("var(--vscode-charts-red)");
});

test("a bar turns warning where the status bar item would", () => {
  const text = tooltip({ windows: [{ kind: "session", usedPercent: 81, resetsAt: null }] }, null, {
    warningThreshold: 80,
    errorThreshold: 95,
  });

  expect(cells(windowBlock(text, "5-hour")).fillColor).toBe("var(--vscode-charts-yellow)");
});

test("each optional line appears only when there is something to say", () => {
  expect(tooltip()).not.toContain("<b>Credits</b>");
  expect(tooltip()).not.toContain("Last refresh failed");
  expect(tooltip({ plan: null })).toContain("<b>Claude Code usage</b><p></p><hr>");

  const stopped = tooltip({ blocked: "Spend limit reached", credits: "3 reset credits" });
  expect(stopped).toContain(
    `${STEP}&nbsp;&nbsp;<span style="color:var(--vscode-charts-red);">$(error)</span> <b>Spend limit reached</b>`,
  );
  expect(stopped.indexOf("Spend limit reached")).toBeLessThan(stopped.indexOf("5-hour"));
  expect(stopped).toContain("<b>Credits</b>");
  expect(stopped).toContain("· 3 reset credits");
});

test("credits say when the soonest of them expires", () => {
  const text = tooltip(
    { credits: "2 reset credits", creditsExpireAt: new Date("2026-08-12T17:31:00Z") },
    null,
    { locale: "en-US-u-hc-h23" },
  );

  expect(drawnLines(text)).toContainEqual(
    expect.stringMatching(/^ {2}Credits · 2 reset credits · expires \w+ \d+, \d\d:\d\d$/),
  );
  expect(tooltip({ credits: "2 reset credits" })).not.toContain("expires");
});

test("a failed refresh is stated beside the reading it failed to replace", () => {
  const text = tooltip({}, "connection refused");

  expect(text).toContain(
    `<h6></h6>${INDENT}<span style="color:var(--vscode-charts-yellow);">Last refresh failed:</span> <span style="color:var(--vscode-descriptionForeground);">connection refused</span>`,
  );
  expect(drawnLines(text)).toContain("  Last refresh failed: connection refused");
  expect(text.indexOf("Last refresh failed")).toBeGreaterThan(text.indexOf("From Claude account"));
  expect(text.indexOf("Last refresh failed")).toBeLessThan(text.indexOf("Refresh</a>"));
});

test("what to do about a failure is marked as advice rather than left in the sentence", () => {
  const text = tooltip({}, "The Claude Code sign-in has expired. Run Claude Code to renew it.");

  expect(drawnLines(text)).toContain("  Last refresh failed: The Claude Code sign-in has expired.");
  expect(drawnLines(text)).toContain("  @ Run Claude Code to renew it.");
  expect(text).toContain(
    `${STEP}${INDENT}<span style="color:var(--vscode-descriptionForeground);">`,
  );
});

test("a failure with no remedy is stated without one", () => {
  const drawn = drawnLines(tooltip({}, "The usage service could not be reached."));

  expect(drawn).toContain("  Last refresh failed: The usage service could not be reached.");
  expect(tooltip({}, "The usage service could not be reached.")).not.toContain("$(lightbulb)");
});

test("a message in a provider's own words is drawn rather than read for advice", () => {
  const text = verbatimTooltip("Session not found. Restart the app server and try again.");

  expect(drawnLines(text)).toContain("  Last refresh failed: Session not found.");
  expect(drawnLines(text)).toContain("  Restart the app server and try again.");
  expect(text).not.toContain("$(lightbulb)");
});

test("a message longer than the block draws is cut rather than replaced", () => {
  const said =
    "Codex could not start the app server because the binary at the resolved path is not executable and no other install was found";
  const drawn = drawnLines(verbatimTooltip(said)).join(" ").replace(/\s+/g, " ");
  const shown = drawn.slice(drawn.indexOf("Codex could not"), drawn.indexOf("…"));

  expect(drawn).toContain("…");
  expect(drawn).not.toContain("no other install was found");
  expect(said.startsWith(shown)).toBe(true);
  expect(said.charAt(shown.length)).toBe(" ");
});

test("a message of two sentences is broken at the sentence rather than at the column", () => {
  const drawn = drawnLines(
    buildMessageTooltip(
      "Claude Code usage",
      "agent-usage-bar-claude",
      "The Claude Code sign-in has expired. Run Claude Code to renew it.",
    ),
  );

  expect(drawn).toContain("  The Claude Code sign-in has expired.");
  expect(drawn).toContain("  Run Claude Code to renew it.");
});

test("a message with a sentence too long for a line is wrapped as one run of words", () => {
  const long =
    "No sign-in. Run Claude Code once, allow the keychain prompt, and refresh this reading";
  const drawn = drawnLines(
    buildMessageTooltip("Claude Code usage", "agent-usage-bar-claude", long),
  );

  expect(drawn).not.toContain("  No sign-in.");
  expect(drawn.join(" ").replace(/\s+/g, " ")).toContain(long);
});

test("a window past its reset says so instead of showing a stale number", () => {
  const text = tooltipAt(new Date("2026-08-01T16:00:00Z"));

  expect(windowBlock(text, "5-hour")).toContain(">~ Reset since this reading<");
  expect(windowBlock(text, "5-hour")).toMatch(heading("5-hour", "0%"));
  expect(cells(windowBlock(text, "5-hour"))).toMatchObject({ filled: 0, track: BAR_CELLS });
  expect(windowBlock(text, "Weekly")).toContain(">Resets ");
  expect(windowBlock(text, "Weekly")).toMatch(heading("Weekly", "41%"));
});

test("the 5-hour window is paced to a rate and the weekly one only to the calendar", () => {
  const text = tooltip();

  expect(windowBlock(text, "5-hour")).toMatch(
    /<td align="right"><span style="color:[^"]+">At this pace, ~34% by reset<\/span>/,
  );
  expect(windowBlock(text, "Weekly")).toMatch(
    /<td align="right"><span style="color:[^"]+">68% of the week gone<\/span>/,
  );
});

test("a footnote row and its pace fit across the bar together", () => {
  for (const percentageMode of ["used", "remaining"] as const) {
    const text = tooltip({}, null, { percentageMode });
    for (const [, left, right] of text.matchAll(
      /<table width="100%"><tr><td>(.*?)<\/td><td align="right">(.*?)<\/td><\/tr><\/table>/g,
    )) {
      const row = drawnLines(`${left}</td>${right}`).join("");
      expect(row.length).toBeLessThanOrEqual(ROW_COLUMNS);
      expect(row.trim().length).toBeGreaterThan(0);
    }
  }
});

test("a window spending faster than it refills is paced to the moment it runs out", () => {
  const text = tooltip({
    windows: [{ kind: "session", usedPercent: 60, resetsAt: new Date("2026-08-01T13:12:00Z") }],
  });

  expect(windowBlock(text, "5-hour")).toMatch(
    /<td align="right"><span style="color:[^"]+">At this pace, runs out ~/,
  );
});

test("the pace holds still while the reading does, and goes away with its setting", () => {
  expect(tooltipAt(new Date(now.getTime() + 47 * 60_000))).toContain("At this pace, ~34% by reset");

  const off = tooltip({}, null, { showPace: false });
  expect(off).not.toContain("At this pace");
  expect(off).not.toContain("of the week gone");
  expect(off).toMatch(
    new RegExp(`</h3><div><small>.+<table width="100%"><tr><td>${INDENT}<span [^>]*>Resets .+`),
  );
  expect(off).toContain(`<td align="right">${INDENT}</td>`);
});

test("the percentage mode the item uses is the one the tooltip explains", () => {
  const text = tooltip({}, null, { percentageMode: "remaining" });

  expect(text).toMatch(heading("5-hour", "88%"));
  expect(text).toMatch(heading("Weekly", "59%"));
  expect(text).toContain(">remaining<");
  expect(text).not.toContain(">used<");
  expect(cells(windowBlock(text, "Weekly"))).toMatchObject({ filled: 129, track: 185 });
});

test("an age is stated beside the reading it belongs to, not on its own", () => {
  expect(tooltip({}, null, {}, "2h ago")).toContain("as of ");
  expect(tooltip({}, null, {}, "2h ago")).toContain(" · 2h ago");
  expect(tooltip()).not.toContain("ago<");
});

test("a configured locale writes every date in the tooltip", () => {
  const twelve = tooltip({}, null, { locale: "en-US-u-hc-h12" });
  const twentyFour = tooltip({}, null, { locale: "en-US-u-hc-h23" });

  expect(windowBlock(twelve, "5-hour")).toContain("PM");
  expect(windowBlock(twentyFour, "5-hour")).not.toContain("PM");
  expect(twelve).toMatch(/as of .*(AM|PM)/);
  expect(twentyFour).not.toMatch(/as of .*(AM|PM)/);
  const spent = { windows: [{ ...snapshot.windows[0]!, usedPercent: 60 }] };
  expect(windowBlock(tooltip(spent, null, { locale: "en-US-u-hc-h12" }), "5-hour")).toMatch(
    /runs out ~.*(AM|PM)/,
  );
  expect(windowBlock(tooltip(spent, null, { locale: "en-US-u-hc-h23" }), "5-hour")).not.toMatch(
    /runs out ~.*(AM|PM)/,
  );
});

test("a scoped window gets its own block, named after the scope", () => {
  const text = tooltip({
    windows: [
      ...snapshot.windows,
      {
        kind: "weekly",
        usedPercent: 62,
        resetsAt: new Date("2026-08-03T15:00:00Z"),
        label: "Fable",
      },
    ],
  });

  expect(text).toMatch(heading("Weekly", "41%"));
  expect(text).toMatch(heading("Weekly · Fable", "62%"));
});

test("a scope name is provider text and cannot become markup", () => {
  const text = tooltip({ windows: [{ ...snapshot.windows[0]!, label: "<b>x</b>" }] });

  expect(text).toContain(escapeHtml("<b>x</b>"));
  expect(text).not.toContain("<b>x</b>");
});

test("a Codex reading names Codex as where it came from", () => {
  expect(tooltip({ source: "codex-app-server" })).toContain("From Codex account · as of ");
});

test("a tooltip with no reading still says whose it is and offers a way back", () => {
  const text = buildMessageTooltip(
    "Codex usage",
    "agent-usage-bar-codex",
    "Codex is not signed in",
  );

  expect(text).toContain(
    `<div><h1></h1>${INDENT}$(agent-usage-bar-codex) <b>Codex usage</b><p></p><hr>`,
  );
  expect(text.endsWith("<h1></h1></div>")).toBe(true);
  expect(text).toContain("Codex is not signed in");
  expect(text).toContain(`href="command:${TOOLTIP_COMMANDS[0]}"`);
});
