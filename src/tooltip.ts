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
} as const;

/** Nested `<small>` elements reduce the bar to roughly four pixels inside an `h3`. */
const BAR_SCALE = 7;

/**
 * The scaled cells make the bar the widest line. Wrapped text uses a conservative width for
 * proportional glyphs; failure lines may use the measured wider limit.
 */
const BAR_CELLS = 320;

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
  const meter = `${bar(window.usedPercent, severityFor(window, configuration, asOf))}${INDENT}`;
  return [
    `<h3>${INDENT}${dim(windowTitle(window))}${INDENT}${percent} <small>${dim(label)}</small>`,
    `<br>${INDENT}${meter}</h3>`,
    detailRow(
      reset,
      pace ? escapeHtml(formatPace(pace, (at) => formatMoment(at, configuration.locale))) : "",
    ),
  ].join("");
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
