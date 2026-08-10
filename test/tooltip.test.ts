import { expect, test } from "vitest";
import type { ExtensionConfiguration } from "../src/configuration";
import { buildMessageTooltip, buildTooltip, escapeHtml, TOOLTIP_COMMANDS } from "../src/tooltip";
import type { UsageSnapshot } from "../src/usage";

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
    failure === null ? null : { message: failure },
    age,
    now,
  );
}

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
  expect(text.startsWith("<div><h1></h1>")).toBe(true);
  expect(text.endsWith("<h1></h1></div>")).toBe(true);
  expect(text).toContain(`<p></p><hr><h6></h6>${STEP}`);
  expect(text).toContain(`<p></p>${STEP}<hr><h1></h1>`);
  expect(text).toContain(`${INDENT}$(agent-usage-bar-claude) <b>Claude Code usage</b>`);
  expect(text).toContain("· plus");
  const session = windowBlock(text, "5-hour");
  expect(session).toMatch(heading("5-hour", "12%"));
  expect(session).toContain(">used<");
  expect(session.split("<br>")).toHaveLength(2);
  expect(session).toMatch(
    new RegExp(`</h3><table width="100%"><tr><td>${INDENT}<span style="color:[^"]+">Resets .+`),
  );
  expect(text).toContain("From Claude account · as of ");
  expect(text.indexOf("Refresh")).toBeGreaterThan(text.indexOf("From Claude account"));
});

test("the whole tooltip is one html block with no blank line in it", () => {
  const text = tooltip({ plan: "a\n\nb", credits: "c\n\nd" }, "e\n\nf");

  expect(text).not.toContain("\n");
  expect(text.match(/<div>/g)).toHaveLength(1);
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

test("every element and every attribute the tooltip writes survives the renderer's allowlist", () => {
  const text = [
    tooltip({ blocked: "Spend limit reached", credits: "3 reset credits" }, "connection refused"),
    tooltip({}, null, {}, "2h ago"),
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

  expect(bar(0)).toEqual({ filled: 0, track: 320 });
  expect(bar(100)).toEqual({ filled: 320, track: 0 });
  expect(bar(50)).toEqual({ filled: 160, track: 160 });
  expect(bar(12.4)).toEqual({ filled: 40, track: 280 });
  expect(bar(99.9)).toEqual({ filled: 320, track: 0 });
});

test("a bar is one rounded track with a rounded fill nested in it", () => {
  const session = windowBlock(tooltip(), "5-hour");

  expect(session).toContain(
    '<span style="background-color:var(--vscode-editorWidget-border);border-radius:4px;"><span style="background-color:var(--vscode-charts-blue);border-radius:4px;">',
  );
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
  expect(stopped).toContain(
    `${STEP}&nbsp;&nbsp;<span style="color:var(--vscode-charts-red);">$(error)</span> <b>Spend limit reached</b>`,
  );
  expect(stopped.indexOf("Spend limit reached")).toBeLessThan(stopped.indexOf("5-hour"));
  expect(stopped).toContain("<b>Credits</b>");
  expect(stopped).toContain("· 3 reset credits");
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
  expect(cells(windowBlock(text, "5-hour"))).toMatchObject({ filled: 0, track: 320 });
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
  expect(cells(windowBlock(text, "Weekly"))).toMatchObject({ filled: 131, track: 189 });
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
