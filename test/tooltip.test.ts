import { expect, test } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import { buildMessageTooltip, buildTooltip, escapeHtml, TOOLTIP_COMMANDS } from "../src/tooltip";
import type { UsageSnapshot } from "../src/usage";

/**
 * The tooltip is the far end of the only path in this extension that carries someone else's text to
 * the screen: a plan name, a stop reason, a credit balance, and the message from a failed read all
 * come from a service or from another window's stored entry. It is drawn as trusted markdown with
 * html and theme icons enabled, which makes every one of them a chance to draw something that was
 * never a reading — a link that runs a command most of all.
 *
 * The markup it writes is checked here against the same allowlist the renderer applies, because
 * html the sanitizer drops is not a bar that fails loudly — it is a blank line where one was.
 */

const now = new Date("2026-08-01T10:00:00Z");

/** VS Code keeps `style` on a `<span>` alone, and only these three declarations, in this order. */
const ALLOWED_STYLE =
  /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/;

/** The tags the renderer keeps, narrowed to the ones this tooltip has any business writing. */
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

/** The empty box that lands a gap between two rungs of the margin ladder. */
const STEP = "<table><tr><td></td></tr></table>";

/** What every line of text is broken to, and so what no line of text may be longer than. */
const COLUMNS = 52;

/**
 * What a line that is not wrapped to anything may be: the two cells of a footnote row together, and
 * the failure heading with a short message riding on it. Larger than `COLUMNS`, and that is not a
 * loosening: `COLUMNS` is what wrapped text is broken to, deliberately short of what the bar is
 * worth so that a line of the widest characters still fits under it. These lines are taken whole
 * instead, and measured on screen there are about sixty characters of proportional text before one
 * reaches the end of the bar.
 *
 * Past that a row's cells wrap rather than the tooltip widening, since a table's own width is what
 * a cell is laid out against. Ugly, not broken — but the row is the one line here whose length no
 * function controls, being two locale-formatted values written by two different providers.
 */
const ROW_COLUMNS = 60;

/** The indent every line carries, which is the left padding the hover would not give us. */
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

function tooltip(
  reading: Partial<UsageSnapshot> = {},
  failure: string | null = null,
  overrides: Partial<ExtensionConfiguration> = {},
  age: string | null = null,
): string {
  return buildTooltip(
    "Claude Code usage",
    "agent-usage-bar-claude",
    { ...snapshot, ...reading },
    configure(overrides),
    failure,
    age,
    now,
  );
}

/** The same reading, drawn at a later moment than it was taken. */
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

/** The line a window opens with: its name, dimmed rather than unbolded, then what it has cost. */
function heading(kind: string, percent: string): RegExp {
  return new RegExp(
    `<h3>${INDENT}<span style="color:[^"]+">${kind}</span>${INDENT}${percent} <small>`,
  );
}

/** One window's worth of the tooltip: the heading it is named and drawn in, and its reset line. */
function windowBlock(text: string, kind: "5-hour" | "Weekly"): string {
  return text.split(/<h6>&nbsp;<\/h6>|<hr>/).find((part) => part.includes(`>${kind}</span>`)) ?? "";
}

/** The two spaces every line is indented by, as a reader sees them rather than as they are written. */
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
 * The lines a reader is shown: the markup gone, the entities read back as themselves, and one line
 * per break. The bars come out as lines of nothing, and are dropped with the empty ones — they are
 * the widest thing on the tooltip by design, and so the one thing the width is not measured on.
 *
 * A cell ends a run of text the way a break does. Two of them share one line on the screen, but
 * they are wrapped apart and belong to different edges, so what each may be is its own question;
 * what the pair may be together is the test below that measures the row.
 */
function drawnLines(text: string): string[] {
  return text
    .split(/<br>|<\/?h[1-6]>|<\/?p>|<hr>|<\/div>|<\/td>/)
    .map((part) =>
      part
        .replace(/<[^>]+>/g, "")
        // A codicon is written as its name and drawn as one glyph, so it is counted as one.
        .replace(/\$\([a-z0-9-]+\)/g, "@")
        .replace(/&[a-z]+;|&#\d+;/g, (entity) => CHARACTERS[entity] ?? entity),
    )
    .filter((part) => part.trim());
}

/** The two segments of a bar, as the number of cells each was given. */
function cells(text: string): { filled: number; track: number; fillColor: string } {
  const bar =
    /<span style="background-color:([^;]+);border-radius:4px;">(?:<span style="background-color:([^;]+);border-radius:4px;">((?:&nbsp;)*)<\/span>)?((?:&nbsp;)*)<\/span>/.exec(
      text,
    );
  const count = (part: string | undefined): number => (part?.match(/&nbsp;/g) ?? []).length;
  return {
    filled: count(bar?.[3]),
    track: count(bar?.[4]),
    fillColor: bar?.[2] ?? "",
  };
}

test("a reading is drawn as a header, a block per window, and where it came from", () => {
  const text = tooltip();

  expect(text.startsWith("<div>")).toBe(true);
  expect(text.endsWith("</div>")).toBe(true);
  // Both edges and both sides of both rules are padded, since a rule's own bottom margin is
  // negative and would otherwise leave the line under it flush against it.
  expect(text.startsWith("<div><h1></h1>")).toBe(true);
  expect(text.endsWith("<h1></h1></div>")).toBe(true);
  expect(text).toContain(`<p></p><hr><h6></h6>${STEP}`);
  expect(text).toContain(`<p></p>${STEP}<hr><h1></h1>`);
  expect(text).toContain(`${INDENT}$(agent-usage-bar-claude) <b>Claude Code usage</b>`);
  expect(text).toContain("· plus");
  const session = windowBlock(text, "5-hour");
  // What the window is beside what it cost, the bar under it, then the moment it refills and the
  // pace under that. The moment is a local date in the reader's own locale, so what is stated here
  // is everything up to it; that it is escaped on the way in is a later test's business.
  expect(session).toMatch(heading("5-hour", "12%"));
  expect(session).toContain(">used<");
  expect(session.split("<br>")).toHaveLength(2);
  // The footnote row is outside the heading, which is the only way it is not bold.
  expect(session).toMatch(
    new RegExp(`</h3><table width="100%"><tr><td>${INDENT}<span style="color:[^"]+">Resets .+`),
  );
  expect(text).toContain("From Claude account · as of ");
  expect(text.indexOf("Refresh")).toBeGreaterThan(text.indexOf("From Claude account"));
});

/**
 * A blank line is the one thing that ends an html block. Past it the rest of the tooltip goes back
 * to the markdown parser, which draws the same words with none of this file's spacing.
 */
test("the whole tooltip is one html block with no blank line in it", () => {
  const text = tooltip({ plan: "a\n\nb", credits: "c\n\nd" }, "e\n\nf");

  expect(text).not.toContain("\n");
  expect(text.match(/<div>/g)).toHaveLength(1);
  // Flattened rather than dropped, so a message that arrives with newlines still reads.
  expect(text).toContain("a b");
  expect(text).toContain("e f");
});

/**
 * The item beside it counts the minutes down; the tooltip states the moment instead. A tooltip that
 * changed with the clock would be republished while it was open, and the workbench answers a
 * republished item by rebuilding its hover — which is to say by closing it.
 */
test("nothing on the tooltip moves between one reading and the next", () => {
  expect(tooltipAt(new Date(now.getTime() + 47 * 60_000))).toBe(tooltipAt(now));
  expect(tooltipAt(now)).not.toMatch(/\d+h \d+m/);
});

/**
 * A hover is as wide as the widest line in it, and the bar is a count of cells that knows nothing
 * about how wide the box came out. Left alone, a long message stretches the box and leaves the bar
 * sitting in the middle of it. So the bar is made the widest line on the tooltip, and every line of
 * text is broken to just under it.
 */
test("no line of text is wider than the bar, however much a provider says", () => {
  const message =
    "The Claude Code sign-in has expired. Run Claude Code to renew it, then refresh this reading";
  const text = tooltip({ plan: "a plan name of quite unreasonable length for a plan" }, message);

  for (const line of drawnLines(text)) {
    expect(line.length).toBeLessThanOrEqual(COLUMNS + INDENT_WIDTH);
  }
  // Broken between words rather than through them: read back across the breaks, the message is
  // the message. And every continued line is indented under the line it continues.
  expect(drawnLines(text).join(" ").replace(/\s+/g, " ")).toContain(message);
  expect(text.match(/<br>&nbsp;&nbsp;/g)?.length).toBeGreaterThan(1);

  // The one line held to the other measurement, and only as far as it: a heading with a short
  // message on it is not wrapped to anything, so what it may be is what the bar is worth.
  const short = drawnLines(tooltip({}, "Rate limited. Retrying at 12:23 AM."));
  const stated = (drawn: string): boolean => drawn.includes("Last refresh failed");
  const failure = short.filter(stated);
  expect(failure).toHaveLength(1);
  expect(failure[0]?.length).toBeLessThanOrEqual(ROW_COLUMNS + INDENT_WIDTH);
  for (const rest of short.filter((drawn) => !stated(drawn))) {
    expect(rest.length).toBeLessThanOrEqual(COLUMNS + INDENT_WIDTH);
  }
});

test("every element and every attribute the tooltip writes survives the renderer's allowlist", () => {
  const text = [
    tooltip({ blocked: "Spend limit reached", credits: "3 reset credits" }, "connection refused"),
    tooltip({}, null, {}, "2h ago"),
    buildMessageTooltip("Codex usage", "agent-usage-bar-codex", "no reading yet"),
  ].join("");

  for (const [, tag] of text.matchAll(/<\/?([a-z][a-z0-9]*)/g)) {
    expect(ALLOWED_TAGS).toContain(tag);
  }
  // `style` is dropped from anything but a span. The rest are the plain attributes the renderer
  // allows outright — `align` and `width` sit on its list beside `colspan` and `rowspan`, which is
  // what makes a cell the one way to reach a right edge from here.
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
  // Every field below is a string the extension did not write. `command:` is the one that matters
  // most: the tooltip is trusted, so a link to one runs it on a click, and the escaping below is
  // the whole of what stands in the way — hence the test above, which states that the only links
  // on a tooltip are the two it writes itself.
  const payload = '$(error) <a href="command:workbench.action.quit">x</a> <span style="x">y</span>';
  const text = tooltip({ plan: payload, blocked: payload, credits: payload }, payload);

  // The one `$(error)` that renders is the one the extension wrote beside the stop reason; the
  // four the payload carries — plan, stop reason, balance, failure — are all spelled out instead.
  expect(text.match(/\$\(error\)/g)).toHaveLength(1);
  expect(text.match(/\$&#40;error&#41;/g)).toHaveLength(4);
  expect(text).toContain('<span style="color:var(--vscode-charts-red);">$(error)</span>');
  expect(text).not.toContain('href="command:workbench');
  expect(text).not.toContain('<span style="x">');
  expect(text).not.toContain('<a href="command:workbench.action.quit">');
  // Escaped rather than stripped: the user still gets to read what the service said, though a
  // string this long is read across as many lines as the width of the bar allows.
  expect(text).toContain("href=&quot;command:workbench.action.quit&quot;&gt;x&lt;/a&gt;");
  expect(text).toContain("&lt;a");
});

test("the escaping covers every character html or the icon renderer gives a meaning to", () => {
  expect(escapeHtml("<b>&amp;</b>")).toBe("&lt;b&gt;&amp;amp;&lt;/b&gt;");
  expect(escapeHtml("$(alert) and $(x)")).toBe("$&#40;alert&#41; and $&#40;x&#41;");
  expect(escapeHtml('say "hi" o\'clock')).toBe("say &quot;hi&quot; o&#39;clock");
  // Whitespace is flattened, so no value can end the html block the layout lives in.
  expect(escapeHtml("two\n\nlines\ttabbed")).toBe("two lines tabbed");
  // Markdown metacharacters are left alone: inside an html block they are text like any other.
  expect(escapeHtml("**bold** [x] ~a~ 42")).toBe("**bold** [x] ~a~ 42");
});

test("the bar fills to the percent and its two segments always total a full bar", () => {
  const bar = (usedPercent: number): { filled: number; track: number } => {
    const { filled, track } = cells(
      tooltip({ windows: [{ kind: "session", usedPercent, resetsAt: null }] }),
    );
    return { filled, track };
  };

  expect(bar(0)).toEqual({ filled: 0, track: 320 });
  expect(bar(100)).toEqual({ filled: 320, track: 0 });
  expect(bar(50)).toEqual({ filled: 160, track: 160 });
  // Rounded, not floored, and never past the ends whatever the reading says.
  expect(bar(12.4)).toEqual({ filled: 40, track: 280 });
  expect(bar(99.9)).toEqual({ filled: 320, track: 0 });
});

/** The fill sits inside the track, which is the only way a span gets one rounded end. */
test("a bar is one rounded track with a rounded fill nested in it", () => {
  const session = windowBlock(tooltip(), "5-hour");

  expect(session).toContain(
    '<span style="background-color:var(--vscode-editorWidget-border);border-radius:4px;"><span style="background-color:var(--vscode-charts-blue);border-radius:4px;">',
  );
  // Seven nestings of `small`, which takes the line the background sits on down to about 4px —
  // measured from the heading it is drawn inside, whose font starts larger than the body's.
  // Seven of the eight in the block; the last one sizes the word beside the number.
  expect(session.match(/<small>/g)).toHaveLength(8);
  expect(session).toContain("<small><small><small><small><small><small><small><span");
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
  // The stop reason sits under the rule, above the numbers it makes irrelevant.
  expect(stopped).toContain(
    `${STEP}&nbsp;&nbsp;<span style="color:var(--vscode-charts-red);">$(error)</span> <b>Spend limit reached</b>`,
  );
  expect(stopped.indexOf("Spend limit reached")).toBeLessThan(stopped.indexOf("5-hour"));
  expect(stopped).toContain("<b>Credits</b>");
  expect(stopped).toContain("· 3 reset credits");
});

test("a failed refresh is stated beside the reading it failed to replace", () => {
  const text = tooltip({}, "connection refused");

  // Parted from the reading above it by a gap, with the icon standing off from the words rather
  // than against them.
  expect(text).toContain(
    `<h6></h6>${INDENT}<span style="color:var(--vscode-charts-yellow);">$(warning)</span>${INDENT}`,
  );
  // A message that fits reads on the line that introduces it, at the cost of one line rather than
  // two, and no wider than the bar it sits under.
  expect(drawnLines(text)).toContain("  @  Last refresh failed: connection refused");
  // With the age, under the last rule, rather than among the windows.
  expect(text.indexOf("Last refresh failed")).toBeGreaterThan(text.indexOf("From Claude account"));
  expect(text.indexOf("Last refresh failed")).toBeLessThan(text.indexOf("Refresh</a>"));
});

/** The other half of that choice, where the line it would ride on is not worth the half it leaves. */
test("a message too long for that line drops below it and takes the whole width", () => {
  const text = tooltip({}, "The Claude usage service is rate limiting requests.");

  expect(drawnLines(text)).toContain("  @  Last refresh failed:");
  expect(drawnLines(text)).toContain("  The Claude usage service is rate limiting requests.");
});

/** Where a message is broken matters as much as that it fits. */
test("a message of two sentences is broken at the sentence rather than at the column", () => {
  const text = tooltip({}, "The Claude Code sign-in has expired. Run Claude Code to renew it.");

  expect(drawnLines(text)).toContain("  The Claude Code sign-in has expired.");
  expect(drawnLines(text)).toContain("  Run Claude Code to renew it.");
});

test("a message with a sentence too long for a line is wrapped as one run of words", () => {
  const long =
    "No sign-in. Run Claude Code once, allow the keychain prompt, and refresh this reading";
  const drawn = drawnLines(tooltip({}, long));

  expect(drawn).not.toContain("  No sign-in.");
  expect(drawn.join(" ").replace(/\s+/g, " ")).toContain(long);
});

test("a window past its reset says so instead of showing a stale number", () => {
  const text = tooltipAt(new Date("2026-08-01T16:00:00Z"));

  expect(windowBlock(text, "5-hour")).toContain(">Reset since this reading<");
  expect(windowBlock(text, "5-hour")).toMatch(heading("5-hour", "0%"));
  expect(cells(windowBlock(text, "5-hour"))).toMatchObject({ filled: 0, track: 320 });
  // The note is what explains the `~` the status bar text is showing at the same moment.
  expect(text).toContain("marks a window assumed empty after its reset");
  // Only the window that actually reset: the weekly one still states its own moment.
  expect(windowBlock(text, "Weekly")).toContain(">Resets ");
  expect(windowBlock(text, "Weekly")).toMatch(heading("Weekly", "41%"));
});

/**
 * The two windows are paced differently on purpose. A session window opens on the first message
 * sent into it, so the time it has been open is time spent working and extending that rate to the
 * end of the window means something. A weekly window opens on a calendar anchor and runs through
 * nights and days off, which the hours ahead of it hold in quite different measure — so it is
 * clocked rather than forecast, and the reader does the comparing.
 */
test("the 5-hour window is paced to a rate and the weekly one only to the calendar", () => {
  const text = tooltip();

  // Opened at 08:12, five hours before it refills, with 12.4% spent in the 108 minutes since.
  // The pace sits in a cell of its own, pushed to the right of the moment the window refills.
  expect(windowBlock(text, "5-hour")).toMatch(
    /<td align="right"><span style="color:[^"]+">At this pace, ~34% by reset<\/span>/,
  );
  expect(windowBlock(text, "Weekly")).toMatch(
    /<td align="right"><span style="color:[^"]+">68% of the week gone<\/span>/,
  );
});

/**
 * The one line on the tooltip whose length nothing here decides: a reset moment and a forecast
 * moment, both drawn in whatever the reader's locale makes of them. Both cells are measured, in
 * every window, in both percentage modes — the left one does not move with the mode, but the test
 * is cheap and the day it does is the day this should notice.
 */
test("a footnote row and its pace fit across the bar together", () => {
  for (const percentageMode of ["used", "remaining"] as const) {
    const text = tooltip({}, null, { percentageMode });
    // Anchored on the width, which is what tells a footnote row from the empty box that lands a
    // gap between two rungs of the margin ladder — that one is a `<table><tr><td>` too.
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

  // The moment is drawn in the reader's own locale, so what is stated here is everything up to it.
  expect(windowBlock(text, "5-hour")).toMatch(
    /<td align="right"><span style="color:[^"]+">At this pace, runs out ~/,
  );
});

/**
 * The pace is measured from when the reading was taken, not from now — which pairs it with the
 * percentage it divides, and is what keeps it from moving under an open hover between readings.
 */
test("the pace holds still while the reading does, and goes away with its setting", () => {
  expect(tooltipAt(new Date(now.getTime() + 47 * 60_000))).toContain("At this pace, ~34% by reset");

  const off = tooltip({}, null, { showPace: false });
  expect(off).not.toContain("At this pace");
  expect(off).not.toContain("of the week gone");
  // The row stays a table with the right cell emptied rather than becoming a plain line. A cell
  // carries a padding this file cannot turn off, so a footnote in one sits a couple of pixels
  // right of a footnote that is not — and a left edge that only moves sometimes is the visible one.
  expect(off).toMatch(
    new RegExp(`</h3><table width="100%"><tr><td>${INDENT}<span style="color:[^"]+">Resets .+`),
  );
  expect(off).toContain(`<td align="right">${INDENT}</td>`);
});

test("the percentage mode the item uses is the one the tooltip explains", () => {
  const text = tooltip({}, null, { percentageMode: "remaining" });

  expect(text).toMatch(heading("5-hour", "88%"));
  expect(text).toMatch(heading("Weekly", "59%"));
  expect(text).toContain(">remaining<");
  expect(text).not.toContain(">used<");
  // The bar still fills with what is spent, so the color and the length keep their meaning.
  expect(cells(windowBlock(text, "Weekly"))).toMatchObject({ filled: 131, track: 189 });
});

test("an age is stated beside the reading it belongs to, not on its own", () => {
  expect(tooltip({}, null, {}, "2h ago")).toContain("as of ");
  expect(tooltip({}, null, {}, "2h ago")).toContain(" · 2h ago");
  expect(tooltip()).not.toContain("ago<");
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
  // Padded at both edges, so the actions are not flush against the bottom of the box.
  expect(text.endsWith("<h1></h1></div>")).toBe(true);
  expect(text).toContain("Codex is not signed in");
  expect(text).toContain(`href="command:${TOOLTIP_COMMANDS[0]}"`);
});
