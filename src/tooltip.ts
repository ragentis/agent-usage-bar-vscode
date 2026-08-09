import type { ExtensionConfiguration } from "./configuration";
import {
  formatMoment,
  formatPercent,
  type ResolvedWindow,
  resolveWindows,
  severityFor,
  type Severity,
} from "./formatting";
import { formatPace, paceFor } from "./pace";
import type { SnapshotSource, UsageSnapshot, WindowKind } from "./usage";

/**
 * Builds trusted tooltip Markdown from provider-supplied text. Every external value is escaped
 * because trusted Markdown enables HTML, theme icons, and command links.
 *
 * The tooltip uses one HTML element to avoid uncontrollable paragraph margins. Its layout depends
 * on VS Code's sanitizer and hover styles:
 *
 *   - A `<span>` may retain `color`, `background-color`, and `border-radius`, in that order.
 *   - All lines inherit the hover's fixed line height, so empty block margins provide small gaps.
 *   - `h3` is the largest heading with a predictable workbench margin.
 */

const WINDOW_TITLES: Record<WindowKind, string> = { session: "5-hour", weekly: "Weekly" };

const SOURCE_TITLES: Record<SnapshotSource, string> = {
  "claude-account-api": "Claude account",
  "codex-app-server": "Codex account",
};

/** The tooltip's only links. Escaping prevents provider text from adding another command link. */
export const TOOLTIP_COMMANDS = ["agentUsageBar.refresh", "agentUsageBar.openSettings"] as const;

/**
 * Chart colors are intended for filled shapes on widget backgrounds. `focusBorder` is avoided
 * because themes may mute it as an outline color.
 */
const COLOR = {
  dim: "var(--vscode-descriptionForeground)",
  track: "var(--vscode-editorWidget-border)",
  normal: "var(--vscode-charts-blue)",
  warning: "var(--vscode-charts-yellow)",
  error: "var(--vscode-charts-red)",
} as const;

/** Seven nested `<small>` elements produce an approximately four-pixel bar inside an `h3`. */
const BAR_SCALE = 7;

/**
 * The scaled non-breaking spaces make the bar the tooltip's widest line. Text wraps to the related
 * `COLUMNS` limit so provider messages cannot widen the tooltip beyond the fixed bar.
 */
const BAR_CELLS = 320;

/** Approximate text width of the bar, with margin for proportional glyphs. */
const COLUMNS = 52;

/**
 * Maximum length kept on one line before explicit wrapping. It is larger than `COLUMNS` because
 * measured proportional text normally fits about sixty characters under the bar.
 */
const LINE_COLUMNS = 60;

/** Adds horizontal padding that the hover container does not provide. */
const INDENT = "&nbsp;&nbsp;";

/**
 * Empty blocks provide three predictable vertical gaps through their existing margins. Adjacent
 * margins collapse to the larger value, and an `<hr>` reduces the following gap by four pixels.
 */
const GAP = "<h6></h6>";
const PAD = "<p></p>";
const EDGE = "<h1></h1>";

/** A non-empty heading adds line height when a margin alone is not enough separation. */
const AIR = "<h6>&nbsp;</h6>";

/**
 * An empty table contributes about six pixels without margin collapse, providing an intermediate
 * gap between the block-margin sizes above.
 */
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

/** Normalizes whitespace before measuring and rendering text. */
function flattened(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Wraps visible characters before escaping; `taken` is the space already used on the first line. */
function wrapped(text: string, taken = 0): string {
  const flat = flattened(text);
  return (atSentences(flat, taken) ?? atWords(flat, taken)).map(escapeHtml).join(`<br>${INDENT}`);
}

/**
 * Prefers sentence boundaries when every sentence fits on its own line. Otherwise word wrapping
 * handles the complete message consistently.
 */
function atSentences(text: string, taken: number): string[] | null {
  if (taken + text.length <= COLUMNS) {
    return null;
  }
  const parts = sentences(text);
  const fits = (part: string, index: number): boolean =>
    part.length + (index === 0 ? taken : 0) <= COLUMNS;
  return parts.length > 1 && parts.every(fits) ? parts : null;
}

/** Splits at sentence-ending punctuation while preserving the punctuation. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

/** Wraps at spaces and leaves oversized words, including URLs, for the renderer to break. */
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

/** Nests the fill inside the track so both retain rounded ends without a seam between segments. */
function bar(usedPercent: number, severity: Severity): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((usedPercent / 100) * BAR_CELLS)));
  const cell = "&nbsp;";
  const fill =
    filled > 0
      ? span(cell.repeat(filled), `background-color:${COLOR[severity]};border-radius:4px;`)
      : "";
  return scaled(
    span(
      `${fill}${cell.repeat(BAR_CELLS - filled)}`,
      `background-color:${COLOR.track};border-radius:4px;`,
    ),
  );
}

function formatDate(date: Date, locale?: string): string {
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Joins inline content without a trailing `<br>`, which would add an empty line before a block. */
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
 * Renders a usage window as a two-line heading followed by reset and pace details. The heading owns
 * the percentage and bar because it provides a compact line height. Details stay outside it to
 * avoid inherited bold text.
 *
 * Reset and pace values are fixed to the reading timestamp. Updating them with the clock would
 * rebuild an open tooltip and would separate the pace calculation from its measured percentage.
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
  // Right padding belongs on the bar because it determines the tooltip width.
  const meter = `${bar(window.usedPercent, severityFor(window.usedPercent, configuration))}${INDENT}`;
  // Keep reset time and projected pace on the same row for direct comparison.
  return [
    `<h3>${INDENT}${dim(WINDOW_TITLES[window.kind])}${INDENT}${percent} <small>${dim(label)}</small>`,
    `<br>${INDENT}${meter}</h3>`,
    detailRow(
      reset,
      pace ? escapeHtml(formatPace(pace, (at) => formatMoment(at, configuration.locale))) : "",
    ),
  ].join("");
}

const FAILURE_LABEL = "Last refresh failed:";

/** Width occupied by the failure label and its following space. */
const LABEL_COLUMNS = FAILURE_LABEL.length + 1;

/** Marks a second failure sentence as suggested action without adding another warning color. */
const HINT_ICON = "$(lightbulb)";

/** Width occupied by the hint icon and following space. */
const HINT_COLUMNS = 1 + 1;

/** Failure text and whether it came directly from a provider. */
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
  // Separate snapshot provenance from the reason it is not newer.
  return [source, GAP, failureBlock(failure)].join("");
}

/**
 * Splits extension-authored failures into a cause and an optional remedy. Extension messages follow
 * that two-sentence contract; provider-authored text is rendered verbatim because its sentence
 * structure has no such meaning.
 */
function failureBlock({ message: failure, verbatim }: Failure): string {
  const label = span(FAILURE_LABEL, `color:${COLOR.warning};`);
  // Do not interpret a provider's second sentence as advice.
  if (verbatim) {
    return lines(`${label} ${dim(whole(cut(flattened(failure)), LABEL_COLUMNS))}`);
  }
  const [cause = "", ...rest] = sentences(flattened(failure));
  const hint = rest.join(" ");
  // A small non-collapsing gap separates the optional remedy from the cause.
  return [
    lines(`${label} ${dim(whole(cause, LABEL_COLUMNS))}`),
    ...(hint ? [STEP, lines(`${dim(HINT_ICON)}&nbsp;${dim(whole(hint, HINT_COLUMNS))}`)] : []),
  ].join("");
}

/** Keeps short failure text on one line and wraps it when it exceeds the measured line width. */
function whole(text: string, taken: number): string {
  return taken + text.length <= LINE_COLUMNS ? escapeHtml(text) : wrapped(text, taken);
}

/** Maximum provider failure text that fits across two wrapped lines. */
const MESSAGE_COLUMNS = COLUMNS - LABEL_COLUMNS + COLUMNS;

/** Truncates provider failures to two lines so actions remain visible in the non-scrolling hover. */
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
  // Two spaces on each side keep the separator visually distinct from both actions.
  return lines(
    `${link(TOOLTIP_COMMANDS[0], "$(refresh) Refresh")}${INDENT}${dim("·")}${INDENT}${link(TOOLTIP_COMMANDS[1], "$(settings-gear) Settings")}`,
  );
}

/** Keeps all blocks inside one HTML element; a blank line would resume Markdown parsing. */
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
): string {
  // Account for the icon and title when wrapping the plan on the same line.
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
    // AIR adds non-collapsing space between window headings.
    if (index > 0) {
      blocks.push(AIR);
    }
    blocks.push(windowBlock(window, configuration, snapshot.fetchedAt));
  }
  if (snapshot.credits) {
    blocks.push(GAP, lines(`<b>Credits</b> ${dim(`· ${wrapped(snapshot.credits, 10)}`)}`));
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

/** Builds the same frame without usage data while preserving refresh and settings actions. */
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
