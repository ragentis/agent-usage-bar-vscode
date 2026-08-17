import type { ExtensionConfiguration, ThemeKind } from "./configuration";
import {
  formatMoment,
  formatPercent,
  type ResolvedWindow,
  resolveWindows,
  severityFor,
  type Severity,
} from "./formatting";
import {
  dayStart,
  HISTORY_DAYS,
  historyStrip,
  localDay,
  type DailyTotals,
  type HistoryStrip,
} from "./history";
import { formatPace, paceFor } from "./pace";
import type { SnapshotSource, UsageSnapshot, WindowKind } from "./usage";

/**
 * Tooltip Markdown is trusted to enable HTML, theme icons, and command links, so every external
 * value must be escaped. The layout stays in one HTML block and uses only markup retained by VS
 * Code's sanitizer.
 */

const WINDOW_TITLES: Record<WindowKind, string> = { session: "5-hour", weekly: "Weekly" };

const SOURCE_TITLES: Record<SnapshotSource, string> = {
  "claude-account-api": "Claude account",
  "codex-app-server": "Codex account",
};

/** The only command links trusted tooltip Markdown may contain. */
export const TOOLTIP_COMMANDS = ["agentUsageBar.refresh", "agentUsageBar.openSettings"] as const;

// Chart colors are intended for filled shapes; outline colors may be muted by themes.
const COLOR = {
  dim: "var(--vscode-descriptionForeground)",
  track: "var(--vscode-editorWidget-border)",
  normal: "var(--vscode-charts-blue)",
  warning: "var(--vscode-charts-yellow)",
  error: "var(--vscode-charts-red)",
  mark: "var(--vscode-descriptionForeground)",
  // The halo is the hover's own background, so it cuts the mark out of a fill or the track and
  // vanishes where the mark reaches past the bar.
  halo: "var(--vscode-editorHoverWidget-background)",
} as const;

/**
 * The bar is drawn in the 13px type of a plain block, not the 15.2px of a heading; see `section`.
 * Nested `<small>` elements reduce it from there to roughly four pixels.
 */
const BAR_SCALE = 6;

/**
 * The scaled cells make the bar the widest line. Wrapped text uses a conservative width for
 * proportional glyphs; failure lines may use the measured wider limit.
 *
 * Measured rather than derived. `<small>` does not scale by an exact factor in this renderer, and
 * across six nestings the arithmetic drifts about a percent — four pixels of a bar that has to end
 * where the line of text above it ends.
 */
const BAR_CELLS = 314;

/** The indent beside a bar, in the bar's own cells: a full-size space is a fifth too narrow here. */
const BAR_INDENT_CELLS = 7;

const COLUMNS = 52;

const LINE_COLUMNS = 60;

const INDENT = "&nbsp;&nbsp;";

/**
 * Sanitized CSS cannot provide the required spacing, so retained empty elements form a small gap
 * scale through their native margins and line heights.
 */
const GAP = "<h6></h6>";
const PAD = "<p></p>";
const EDGE = "<h1></h1>";

const AIR = "<h6>&nbsp;</h6>";

const STEP = "<table><tr><td></td></tr></table>";

const RULE = "<hr>";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "(": "&#40;",
  ")": "&#41;",
};

/**
 * Escapes HTML markup and parentheses, which VS Code interprets as part of `$(icon)` syntax before
 * sanitization. Whitespace is flattened because a blank line would end the surrounding HTML block.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[&<>"'()]/g, (character) => ENTITIES[character] ?? character);
}

function flattened(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wrapped(text: string, taken = 0): string {
  const flat = flattened(text);
  return (atSentences(flat, taken) ?? atWords(flat, taken)).map(escapeHtml).join(`<br>${INDENT}`);
}

function atSentences(text: string, taken: number): string[] | null {
  if (taken + text.length <= COLUMNS) {
    return null;
  }
  const parts = sentences(text);
  const fits = (part: string, index: number): boolean =>
    part.length + (index === 0 ? taken : 0) <= COLUMNS;
  return parts.length > 1 && parts.every(fits) ? parts : null;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

function atWords(text: string, taken: number): string[] {
  const broken: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const columns = COLUMNS - (broken.length === 0 ? taken : 0);
    if (line && line.length + 1 + word.length > columns) {
      broken.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return [...broken, line];
}

function span(text: string, style: string): string {
  return `<span style="${style}">${text}</span>`;
}

function dim(text: string): string {
  return text ? span(text, `color:${COLOR.dim};`) : "";
}

function scaled(markup: string): string {
  return `${"<small>".repeat(BAR_SCALE)}${markup}${"</small>".repeat(BAR_SCALE)}`;
}

const CELL = "&nbsp;";

/**
 * The mark is two glyphs from the extension's own icon font, a halo and the mark drawn over it, so
 * that it can stand taller than the bar and be rounded, which cells cannot. See
 * `scripts/build-font.mjs`, which generates both.
 */
const MARK_GLYPH = "agent-usage-bar-mark";

const HALO_GLYPH = "agent-usage-bar-mark-halo";

/**
 * The mark's advance width is exactly this many cells and the halo's is none, so the pair replaces
 * these cells and the bar keeps its length.
 */
const MARK_CELLS = 3;

/** The rounded ends taper the bar, so a mark under one of them would be clipped. */
const MARK_MARGIN = 4;

/** Cells kept clear of the fill edge, whose own position already says the same thing. */
const MARK_CLEARANCE = 3;

/** The cell the mark starts at, or nothing when the bar cannot show it centred where it belongs. */
function markAt(elapsedPercent: number | null, filled: number, cells: number): number | null {
  if (elapsedPercent === null) {
    return null;
  }
  const at = Math.round((elapsedPercent / 100) * cells) - Math.floor(MARK_CELLS / 2);
  if (at < MARK_MARGIN || at + MARK_CELLS > cells - MARK_MARGIN) {
    return null;
  }
  const clear = at >= filled + MARK_CLEARANCE || at + MARK_CELLS + MARK_CLEARANCE <= filled;
  return clear ? at : null;
}

const MARK = [
  span(`$(${HALO_GLYPH})`, `color:${COLOR.halo};`),
  span(`$(${MARK_GLYPH})`, `color:${COLOR.mark};`),
].join("");

/**
 * Replaces cells in place rather than dividing the run, so a marked segment keeps its rounded ends
 * and the bar keeps its exact cell count.
 */
function marked(count: number, at: number | null): string {
  if (at === null) {
    return CELL.repeat(count);
  }
  return `${CELL.repeat(at)}${MARK}${CELL.repeat(count - at - MARK_CELLS)}`;
}

/** Nests the fill inside the track so both retain rounded ends without a seam between segments. */
function bar(
  usedPercent: number,
  severity: Severity,
  elapsedPercent: number | null,
  cells = BAR_CELLS,
): string {
  const filled = Math.min(cells, Math.max(0, Math.round((usedPercent / 100) * cells)));
  const at = markAt(elapsedPercent, filled, cells);
  const onFill = at !== null && at < filled;
  const fill =
    filled > 0
      ? span(
          marked(filled, onFill ? at : null),
          `background-color:${COLOR[severity]};border-radius:4px;`,
        )
      : "";
  const rest = marked(cells - filled, at !== null && !onFill ? at - filled : null);
  return span(`${fill}${rest}`, `background-color:${COLOR.track};border-radius:4px;`);
}

const ROW_INDENT = CELL.repeat(BAR_INDENT_CELLS);

/** The bar and the indent beside it, scaled together because the bar is drawn in these same cells. */
function barRow(run: string): string {
  return scaled(`${ROW_INDENT}${run}${ROW_INDENT}`);
}

/** The same indent for a row drawn at full size, where only the spacing is scaled. */
function glyphRow(run: string): string {
  return `${scaled(ROW_INDENT)}${run}${scaled(ROW_INDENT)}`;
}

function formatDate(date: Date, locale?: string): string {
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(day: string, locale?: string): string {
  return new Date(dayStart(day)).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/**
 * A day is one glyph from the extension's own icon font: a bar of its step's height, standing on the
 * text baseline, carrying the gap to the next day inside its advance width. Nothing here draws with
 * cells, because a cell's width and height both follow the one font size and a taller day would only
 * be a wider one. See `scripts/build-font.mjs`, which generates the bars and their metrics.
 */
const HEAT_GLYPH = "agent-usage-bar-day";

/**
 * Steps are named, never numbered. An icon whose id contains a digit registers and gets its CSS
 * rule, but the Markdown sanitizer keeps a codicon class only when it matches
 * `/^codicon codicon-[a-z-]+( codicon-modifier-[a-z-]+)?$/`. A digit fails that, the class is
 * stripped, and the day draws as an empty element with nothing reported.
 */
const HEAT_NAMES = ["none", "one", "two", "three", "four", "five"];

/**
 * One hue at five opacities, applied as text color to that glyph. A severity ramp would read a busy
 * day as a failing one. The hue is written out rather than taken from `--vscode-charts-blue` because
 * a theme color cannot carry an opacity; these are the values that variable holds in the default
 * themes, and every step below full blends toward whatever the hover behind it actually is.
 */
const HEAT_HUE: Record<ThemeKind, string> = { dark: "#3794ff", light: "#1a85ff" };

const HEAT_STEPS = ["59", "80", "a6", "d0", "ff"];

function heatDay(level: number, theme: ThemeKind): string {
  const name = HEAT_NAMES[level];
  const step = HEAT_STEPS[level - 1];
  if (!name || !step) {
    return span(`$(${HEAT_GLYPH}-none)`, `color:${COLOR.track};`);
  }
  return span(`$(${HEAT_GLYPH}-${name})`, `color:${HEAT_HUE[theme]}${step};`);
}

function heatRow(strip: HistoryStrip, theme: ThemeKind): string {
  return strip.days.map((day) => heatDay(day.level, theme)).join("");
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  return value >= 1_000 ? `${Math.round(value / 1_000)}K` : `${Math.round(value)}`;
}

/**
 * Codex records the account's own percentages, so its days are absolute. Claude records only tokens,
 * which are shown as a count and scaled against the busiest day rather than against any limit.
 */
function historyBlock(
  totals: DailyTotals,
  configuration: ExtensionConfiguration,
  now: Date,
): string {
  const strip = historyStrip(totals, HISTORY_DAYS, localDay(now));
  const first = strip?.days[0];
  if (!strip || !first) {
    return "";
  }
  const busiest =
    strip.unit === "percent"
      ? `${Math.round(strip.busiest.value)}%`
      : `${formatCount(strip.busiest.value)} tokens`;
  const title = `${INDENT}${dim("Daily activity")}${INDENT}${busiest} <small>${dim("busiest day")}</small>`;
  // The tallest day rises past its line box, so the strip is set one step lower than a bar.
  return section(
    title,
    STEP,
    glyphRow(heatRow(strip, configuration.theme)),
    detailRow(escapeHtml(formatDay(first.day, configuration.locale)), "today"),
  );
}

function lines(...content: string[]): string {
  return content.map((line) => `${INDENT}${line}`).join("<br>");
}

/**
 * Aligns reset and pace details at opposite edges. A full-width table is used because the sanitizer
 * permits cell `align` and `width` attributes but not the equivalent CSS declarations.
 */
function detailRow(left: string, right: string): string {
  if (!left && !right) {
    return "";
  }
  return [
    `<table width="100%"><tr><td>${INDENT}${dim(left)}</td>`,
    `<td align="right">${dim(right)}${INDENT}</td></tr></table>`,
  ].join("");
}

/**
 * A title is a heading and what it describes is not. A heading carries 8px of margin under itself,
 * and that space belongs above the drawing rather than between the drawing and the line explaining
 * it, so the two share a plain block. Sanitized CSS offers no other way to place the space.
 */
function section(title: string, ...body: string[]): string {
  return `<h3>${title}</h3><div>${body.join("")}</div>`;
}

function windowTitle(window: ResolvedWindow): string {
  const title = WINDOW_TITLES[window.kind];
  return window.label ? `${title} · ${escapeHtml(window.label)}` : title;
}

/**
 * Reset and pace values use the reading timestamp. Updating them with the clock would detach the
 * forecast from its measured percentage and rebuild an open hover.
 */
function windowBlock(
  window: ResolvedWindow,
  configuration: ExtensionConfiguration,
  asOf: Date,
): string {
  const reset = window.reset
    ? // Reuse the detail row instead of adding a separate reset notice.
      "~ Reset since this reading"
    : window.resetsAt
      ? `Resets ${escapeHtml(formatDate(window.resetsAt, configuration.locale))}`
      : "";
  const pace = configuration.showPace ? paceFor(window, asOf) : null;
  const percent = formatPercent(window.usedPercent, configuration.percentageMode);
  const label = configuration.percentageMode === "remaining" ? "remaining" : "used";
  // Only a weekly window is clocked rather than forecast, so only that bar carries the mark, and it
  // stands exactly where the elapsed percentage beside it says.
  const elapsed = pace?.kind === "elapsed" ? pace.percent : null;
  const severity = severityFor(window, configuration, asOf);
  const title = `${INDENT}${dim(windowTitle(window))}${INDENT}${percent} <small>${dim(label)}</small>`;
  const details = detailRow(
    reset,
    pace ? escapeHtml(formatPace(pace, (at) => formatMoment(at, configuration.locale))) : "",
  );
  return section(title, barRow(bar(window.usedPercent, severity, elapsed)), details);
}

const FAILURE_LABEL = "Last refresh failed:";

const LABEL_COLUMNS = FAILURE_LABEL.length + 1;

const HINT_ICON = "$(lightbulb)";

const HINT_COLUMNS = 1 + 1;

export interface Failure {
  message: string;
  verbatim?: boolean;
}

function footerBlock(
  snapshot: UsageSnapshot,
  age: string | null,
  failure: Failure | null,
  locale: string | undefined,
): string {
  const source = lines(
    dim(
      wrapped(
        `From ${SOURCE_TITLES[snapshot.source]} · as of ${formatDate(snapshot.fetchedAt, locale)}${age ? ` · ${age}` : ""}`,
      ),
    ),
  );
  if (!failure) {
    return source;
  }
  return [source, GAP, failureBlock(failure)].join("");
}

/**
 * Splits extension-authored failures into a cause and an optional remedy. Extension messages follow
 * that two-sentence contract; provider-authored text is rendered verbatim because its sentence
 * structure has no such meaning.
 */
function failureBlock({ message: failure, verbatim }: Failure): string {
  const label = span(FAILURE_LABEL, `color:${COLOR.warning};`);
  if (verbatim) {
    return lines(`${label} ${dim(whole(cut(flattened(failure)), LABEL_COLUMNS))}`);
  }
  const [cause = "", ...rest] = sentences(flattened(failure));
  const hint = rest.join(" ");
  return [
    lines(`${label} ${dim(whole(cause, LABEL_COLUMNS))}`),
    ...(hint ? [STEP, lines(`${dim(HINT_ICON)}&nbsp;${dim(whole(hint, HINT_COLUMNS))}`)] : []),
  ].join("");
}

function whole(text: string, taken: number): string {
  return taken + text.length <= LINE_COLUMNS ? escapeHtml(text) : wrapped(text, taken);
}

const MESSAGE_COLUMNS = COLUMNS - LABEL_COLUMNS + COLUMNS;

function cut(text: string): string {
  if (text.length <= MESSAGE_COLUMNS) {
    return text;
  }
  const kept = text.slice(0, MESSAGE_COLUMNS - 1).trimEnd();
  const space = kept.lastIndexOf(" ");
  return `${space > 0 ? kept.slice(0, space) : kept}…`;
}

function actionsBlock(): string {
  const link = (command: string, label: string): string =>
    `<a href="command:${command}">${label}</a>`;
  return lines(
    `${link(TOOLTIP_COMMANDS[0], "$(refresh) Refresh")}${INDENT}${dim("·")}${INDENT}${link(TOOLTIP_COMMANDS[1], "$(settings-gear) Settings")}`,
  );
}

function tooltip(...blocks: string[]): string {
  return `<div>${blocks.join("")}</div>`;
}

export function buildTooltip(
  title: string,
  icon: string,
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  failure: Failure | null,
  age: string | null,
  now = new Date(),
  history: DailyTotals | null = null,
): string {
  const plan = snapshot.plan ? ` ${dim(`· ${wrapped(snapshot.plan, title.length + 5)}`)}` : "";
  const windows = resolveWindows(snapshot, now);
  // EDGE supplies outer padding; GAP plus STEP compensates for the rule's negative bottom margin.
  const blocks = [
    EDGE,
    lines(`$(${icon}) <b>${escapeHtml(title)}</b>${plan}`),
    PAD,
    RULE,
    GAP,
    STEP,
  ];
  if (snapshot.blocked) {
    blocks.push(
      lines(`${span("$(error)", `color:${COLOR.error};`)} <b>${wrapped(snapshot.blocked, 3)}</b>`),
      GAP,
    );
  }
  for (const [index, window] of windows.entries()) {
    if (index > 0) {
      blocks.push(AIR);
    }
    blocks.push(windowBlock(window, configuration, snapshot.fetchedAt));
  }
  const activity =
    history && configuration.showHistory ? historyBlock(history, configuration, now) : "";
  if (activity) {
    blocks.push(AIR, activity);
  }
  if (snapshot.credits) {
    const expiry = snapshot.creditsExpireAt
      ? ` · expires ${formatDate(snapshot.creditsExpireAt, configuration.locale)}`
      : "";
    blocks.push(
      GAP,
      lines(`<b>Credits</b> ${dim(`· ${wrapped(`${snapshot.credits}${expiry}`, 10)}`)}`),
    );
  }
  // PAD plus STEP creates the larger gap above the footer rule.
  blocks.push(
    PAD,
    STEP,
    RULE,
    EDGE,
    footerBlock(snapshot, age, failure, configuration.locale),
    PAD,
    actionsBlock(),
    EDGE,
  );
  return tooltip(...blocks);
}

export function buildMessageTooltip(title: string, icon: string, message: string): string {
  return tooltip(
    EDGE,
    lines(`$(${icon}) <b>${escapeHtml(title)}</b>`),
    PAD,
    RULE,
    GAP,
    STEP,
    lines(dim(wrapped(message))),
    PAD,
    actionsBlock(),
    EDGE,
  );
}
