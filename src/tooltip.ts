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
 * The one surface where provider text is drawn rather than counted: a plan name, a reason the
 * account is stopped, a credit balance, and the reason the last read failed all reach it as text.
 * Every one of them is escaped on the way in, because what the renderer is handed is trusted
 * markdown with html and theme icons enabled, where a link is a command waiting to be clicked.
 *
 * It is drawn as one html element rather than as markdown paragraphs, which is what buys the
 * spacing. A paragraph in a hover has no rule of its own and falls back to a browser default of
 * about thirteen pixels above and below, and there is no reaching that rule from here. Inside a
 * single element there are no paragraphs to space out, and every gap is one this file put there.
 *
 * What the markup may contain is not up to us either. VS Code sanitizes hover html against a fixed
 * allowlist, and the layout below is built around three of its rules:
 *
 *   - `style` survives on a `<span>` and nowhere else, carrying at most `color`, then
 *     `background-color`, then `border-radius`, in that order, with no spaces, and with values that
 *     are either a hex literal or a `var(--vscode-*)` theme color. No width, no height, no padding.
 *   - `line-height` is set on the hover in `em`, so it computes once and every line inherits the
 *     same nineteen and a half pixels however small its font. Vertical gaps therefore come from the
 *     margins of empty block elements, which are the only small ones on offer.
 *   - Headings above `h3` have no margin rule of their own, so `h3` is the largest text this can
 *     draw without paying a browser default margin for it.
 */

const WINDOW_TITLES: Record<WindowKind, string> = { session: "5-hour", weekly: "Weekly" };

const SOURCE_TITLES: Record<SnapshotSource, string> = {
  "claude-account-api": "Claude account",
  "codex-app-server": "Codex account",
};

/**
 * The two commands the tooltip links to, which the tests beside this file state are the only links
 * a tooltip ever carries. Nothing a provider says can become a third: the angle brackets and
 * parentheses a link is written with are escaped before they are drawn.
 */
export const TOOLTIP_COMMANDS = ["agentUsageBar.refresh", "agentUsageBar.openSettings"] as const;

/**
 * The chart colors, because those are the ones a theme picks to be read as a filled shape against
 * the widget background. `focusBorder`, which the workbench uses for its own quota bars, is chosen
 * to be seen as an outline instead, and a theme that mutes it leaves the bar the color of its track.
 */
const COLOR = {
  dim: "var(--vscode-descriptionForeground)",
  track: "var(--vscode-editorWidget-border)",
  normal: "var(--vscode-charts-blue)",
  warning: "var(--vscode-charts-yellow)",
  error: "var(--vscode-charts-red)",
} as const;

/**
 * A background is only ever as tall as the line it sits on, and the only way down is the font size.
 * Seven nestings measured from the heading the bar is drawn inside — where a font starts half again
 * larger than the body's — land at about four pixels, which is what the workbench draws its own
 * quota bars at.
 */
const BAR_SCALE = 7;

/**
 * A space at that size is worth about a pixel, and a hover is as wide as the widest line in it, up
 * to five hundred. Those two facts make this number and the one under it a single decision: enough
 * cells that the bar is the widest line on the tooltip, and a column count just under it that every
 * line of text is broken to. Together they hold the box at one width whatever a provider says,
 * rather than letting a long message stretch it out around a bar that cannot stretch with it.
 */
const BAR_CELLS = 320;

/** Roughly what the bar is worth in characters of the body font, less a little for safety. */
const COLUMNS = 52;

/**
 * What a line kept or given up whole may be, rather than what wrapped text is broken to. Larger
 * than `COLUMNS`, which is short of the bar on purpose so that a line of the widest characters
 * still fits under it — the right margin to keep where the alternative to fitting is a break this
 * file has to place, and one to give up where the alternative is a second layout. Measured on
 * screen, a line has about sixty characters of proportional text before it reaches the bar's end.
 */
const LINE_COLUMNS = 60;

/** The left padding the hover would not give us, and the right padding, on the widest line. */
const INDENT = "&nbsp;&nbsp;";

/**
 * Vertical space, as empty blocks kept for the margins they collapse to. Adjacent margins collapse
 * rather than add — two of these in a row are worth one, and the larger — so these three and the
 * one below them are the whole of the range: eight pixels from a small heading, thirteen from a
 * paragraph, and seventeen and a half from an `h1`, the one heading the hover leaves the browser's
 * own `0.67em` on, of its own `2em` font, which is where the seventeen comes from.
 *
 * A rule takes four off whichever of them follows it, its bottom margin being negative.
 */
const GAP = "<h6></h6>";
const PAD = "<p></p>";
const EDGE = "<h1></h1>";

/**
 * The rung above the ladder, and the only one that is not a margin: a heading with a space in it,
 * whose line is worth about ten pixels on top of the eight it is margined by either side. Margins
 * collapse and content does not, which is why this is the one that can be told to be larger.
 */
const AIR = "<h6>&nbsp;</h6>";

/**
 * And the half rung between them. An empty cell is a pixel of padding inside two of border spacing,
 * about six pixels of box, and a box collapses with nothing — so written after one of the margins
 * above it adds to it rather than disappearing into it, which is what lands a gap between two rungs
 * that are otherwise eight pixels apart. Nothing is drawn: a hover styles no table of its own, and
 * an unstyled one has neither border nor rule.
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
 * Text, in a document made of html rather than of markdown. The characters an html parser reads as
 * markup, plus the parentheses — the renderer draws `$(icon)` over the finished html, before it is
 * sanitized, so a parenthesis is a metacharacter here even though html has no opinion about it.
 *
 * Whitespace is flattened first. A blank line is the one thing that ends an html block, and a
 * message with two newlines in it would hand the rest of the tooltip back to the markdown parser
 * halfway through the layout.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[&<>"'()]/g, (character) => ENTITIES[character] ?? character);
}

/** What the escaping will make of the whitespace, so text is measured as it will be drawn. */
function flattened(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Text broken to the width of the bar, and escaped after the breaking rather than before it, so
 * what is counted is characters a reader sees rather than the entities some of them turn into.
 *
 * `taken` is what the line it starts on has already spent.
 */
function wrapped(text: string, taken = 0): string {
  const flat = flattened(text);
  return (atSentences(flat, taken) ?? atWords(flat, taken)).map(escapeHtml).join(`<br>${INDENT}`);
}

/**
 * A message of more than one sentence, one sentence to a line — offered first, because a break the
 * text already carries is a better one than any this file can find: "Run Claude Code" parted from
 * "to renew it" reads as two halves of nothing, where the same cut at the full stop reads as a
 * fault and a remedy. Which is what the stops in those messages are there for.
 *
 * All of them or none. A sentence too long for a line of its own would be broken anyway, and one
 * wrapped sentence beside an unwrapped one is a ragged edge with no rule behind it.
 */
function atSentences(text: string, taken: number): string[] | null {
  if (taken + text.length <= COLUMNS) {
    return null;
  }
  const parts = text.split(/(?<=[.!?])\s+/);
  const fits = (part: string, index: number): boolean =>
    part.length + (index === 0 ? taken : 0) <= COLUMNS;
  return parts.length > 1 && parts.every(fits) ? parts : null;
}

/**
 * A word longer than the column it is given is left whole and handed to the renderer, which breaks
 * inside a word when it has to and is the only thing that should: a break this function put
 * mid-word would be a break in a url.
 */
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

/**
 * The fill nested inside the track rather than laid beside it, which is the whole of how a bar gets
 * rounded ends: a radius is all four corners of a span or none, so two segments side by side meet
 * in a notch. Nested, there is no seam to notch — the fill is a pill lying on a rounded track, and
 * both start at the same left edge.
 */
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

function formatDate(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Lines of one paragraph's worth of text. A break is written between them and never after the last
 * one: a trailing `<br>` before a block element leaves an empty line box behind it, which is a
 * nineteen pixel hole in a layout costed in eights.
 */
function lines(...content: string[]): string {
  return content.map((line) => `${INDENT}${line}`).join("<br>");
}

/**
 * Two footnotes on one line, the second pushed to the right edge of the block.
 *
 * A table is the only way there. `text-align` is not among the three declarations a style may
 * carry — but `align` on a cell is on the renderer's attribute allowlist, beside `colspan`,
 * `rowspan` and `width`. The width is what makes the alignment mean anything: a table sizes to its
 * content, so without it the right cell sits against the words on its left rather than under the
 * end of the bar.
 *
 * It stays a table with nothing to push right, where a plain line would do and cost a few pixels
 * of box less. A cell carries a padding and a border spacing that nothing here can turn off —
 * `cellpadding` and `cellspacing` are not on that allowlist — so a footnote in one sits two or
 * three pixels right of a footnote that is not. Paid every time it is a hairline; paid only when
 * there is a pace, it is a left edge that moves between windows and again when one resets.
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
 * One window as a heading of two lines — what it is beside what it costs, and the bar under that —
 * with a footnote row underneath: the moment it refills, and the pace at the far right of it.
 *
 * The first two are inside the heading rather than around it, because a heading is the only element
 * here with a line-height of its own, a factor of its font size rather than the fixed nineteen and
 * a half pixels every other line inherits, and because the eight pixels it is margined by are then
 * spent between windows instead of between a number and the bar that means the same thing.
 *
 * The third is deliberately outside it. Everything in a heading is bold and there is no unbolding
 * it — `font-weight` is not among the three declarations a style may carry — so a line that should
 * read as a footnote has to be a line the heading does not contain. The window's own name has no
 * such way out, being on the line with the number, and is dimmed instead: the same standing down,
 * bought with the one lever that is left.
 *
 * Neither footnote moves with the clock. The item already carries the countdown, and a tooltip that
 * changes every minute is a tooltip the workbench rebuilds from under whoever is reading it — so
 * the reset is stated as a moment, and the pace is measured from `asOf`, when the reading was
 * taken, rather than from now. That also pairs it with the percentage it divides.
 */
function windowBlock(
  window: ResolvedWindow,
  configuration: ExtensionConfiguration,
  asOf: Date,
): string {
  const reset = window.reset
    ? "Reset since this reading"
    : window.resetsAt
      ? `Resets ${escapeHtml(formatDate(window.resetsAt))}`
      : "";
  const pace = configuration.showPace ? paceFor(window, asOf) : null;
  const percent = formatPercent(window.usedPercent, configuration.percentageMode);
  const label = configuration.percentageMode === "remaining" ? "remaining" : "used";
  // The pad on the right rides on the bar because the bar is the widest line on the tooltip, and
  // the widest line is the one that decides where the right edge of the box falls.
  const meter = `${bar(window.usedPercent, severityFor(window.usedPercent, configuration))}${INDENT}`;
  // Side by side because that is the comparison a reader is making: when the window refills,
  // against where the rate is taking it.
  return [
    `<h3>${INDENT}${dim(WINDOW_TITLES[window.kind])}${INDENT}${percent} <small>${dim(label)}</small>`,
    `<br>${INDENT}${meter}</h3>`,
    detailRow(reset, pace ? escapeHtml(formatPace(pace, formatMoment)) : ""),
  ].join("");
}

const FAILURE_LABEL = "Last refresh failed:";

/** What it spends: the icon as the one glyph it is drawn as, its indent, the words, and a space. */
const LABEL_COLUMNS = 1 + 2 + FAILURE_LABEL.length + 1;

function footerBlock(snapshot: UsageSnapshot, age: string | null, failure: string | null): string {
  const source = lines(
    dim(
      wrapped(
        `From ${SOURCE_TITLES[snapshot.source]} · as of ${formatDate(snapshot.fetchedAt)}${age ? ` · ${age}` : ""}`,
      ),
    ),
  );
  if (!failure) {
    return source;
  }
  // Parted from the line above by a gap rather than by a break, because it is a different thing
  // being said: what is on screen, and then why it is not newer.
  const warning = `${span("$(warning)", `color:${COLOR.warning};`)}${INDENT}`;
  const message = flattened(failure);
  // A short message rides on the line that introduces it, at the cost of one line rather than two.
  // A long one drops below, where it has the whole width: sharing the line it would have half the
  // columns and be broken in the middle of itself, which is worse than the line that would save.
  return [
    source,
    GAP,
    LABEL_COLUMNS + message.length <= LINE_COLUMNS
      ? lines(`${warning}${dim(`${FAILURE_LABEL} ${escapeHtml(message)}`)}`)
      : lines(`${warning}${dim(FAILURE_LABEL)}`, dim(wrapped(message))),
  ].join("");
}

function actionsBlock(): string {
  const link = (command: string, label: string): string =>
    `<a href="command:${command}">${label}</a>`;
  // Two spaces either side of the dot rather than one, so the pair reads as two actions with a
  // separator between them rather than as one run of words.
  return lines(
    `${link(TOOLTIP_COMMANDS[0], "$(refresh) Refresh")}${INDENT}${dim("·")}${INDENT}${link(TOOLTIP_COMMANDS[1], "$(settings-gear) Settings")}`,
  );
}

/**
 * One element, with no blank line anywhere inside it. A blank line would end the html block and
 * hand what follows back to the markdown parser, which is a layout in two halves that only the
 * first half of the styling reaches.
 */
function tooltip(...blocks: string[]): string {
  return `<div>${blocks.join("")}</div>`;
}

export function buildTooltip(
  title: string,
  icon: string,
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  failure: string | null,
  age: string | null,
  now = new Date(),
): string {
  // The icon and the title have spent that much of the line the plan continues on.
  const plan = snapshot.plan ? ` ${dim(`· ${wrapped(snapshot.plan, title.length + 5)}`)}` : "";
  const windows = resolveWindows(snapshot, now);
  // The edges are padded to about what the indent gives the left one, which the box has none of
  // otherwise: a hover pads itself by four.
  // Eight of margin plus six of box under the rule, which the rule then takes four of back.
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
    // Margins collapse, so a heading's own eight pixels are all two windows would be parted by.
    if (index > 0) {
      blocks.push(AIR);
    }
    blocks.push(windowBlock(window, configuration, snapshot.fetchedAt));
  }
  if (snapshot.credits) {
    blocks.push(GAP, lines(`<b>Credits</b> ${dim(`· ${wrapped(snapshot.credits, 10)}`)}`));
  }
  if (windows.some((window) => window.reset)) {
    blocks.push(
      GAP,
      lines(
        dim(
          wrapped("~ marks a window assumed empty after its reset. Run the agent for a reading."),
        ),
      ),
    );
  }
  // Thirteen of margin plus six of box over the rule, where nothing is taken back.
  blocks.push(
    PAD,
    STEP,
    RULE,
    EDGE,
    footerBlock(snapshot, age, failure),
    PAD,
    actionsBlock(),
    EDGE,
  );
  return tooltip(...blocks);
}

/**
 * The same frame with a sentence where the numbers would be: a tooltip that has lost its reading
 * still says whose it is, and still offers the one action that might bring it back.
 */
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
