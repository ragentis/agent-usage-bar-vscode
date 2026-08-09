import * as vscode from "vscode";
import type { ExtensionConfiguration } from "./configuration";
import { buildStatusText, formatAge, pickSeverity, type Severity } from "./formatting";
import { buildMessageTooltip, buildTooltip } from "./tooltip";
import type { ProviderId, ProviderView } from "./usage";

/**
 * Status bar order is priority descending, and there is no API to keep two items together.
 * Round priorities such as 100 are what most extensions pick, so anything landing on one of those
 * would split the pair. These sit just off a round value, a hundredth apart. Priority is a float,
 * so a value between them would still sort between them; the gap makes that unlikely, not
 * impossible.
 */
const PROVIDERS: Record<ProviderId, { title: string; icon: string; priority: number }> = {
  claude: { title: "Claude Code usage", icon: "agent-usage-bar-claude", priority: 100.02 },
  codex: { title: "Codex usage", icon: "agent-usage-bar-codex", priority: 100.01 },
};

/** A configured label replaces the mark outright, so the two never compete for width. */
function prefix(provider: ProviderId, configuration: ExtensionConfiguration): string {
  const label = provider === "claude" ? configuration.claudeLabel : configuration.codexLabel;
  return label || `$(${PROVIDERS[provider].icon})`;
}

/** Past this the reading is old enough that its age is worth showing. */
const STALE_AFTER_MS = 10 * 60_000;

const BACKGROUNDS: Record<Severity, vscode.ThemeColor | undefined> = {
  normal: undefined,
  warning: new vscode.ThemeColor("statusBarItem.warningBackground"),
  error: new vscode.ThemeColor("statusBarItem.errorBackground"),
};

export function createStatusBarItem(provider: ProviderId): vscode.StatusBarItem {
  const { title, priority } = PROVIDERS[provider];
  const item = vscode.window.createStatusBarItem(
    `agentUsageBar.${provider}`,
    vscode.StatusBarAlignment.Right,
    priority,
  );
  item.name = title;
  item.command = "agentUsageBar.openMenu";
  return item;
}

export function showLoading(
  item: vscode.StatusBarItem,
  provider: ProviderId,
  configuration: ExtensionConfiguration,
): void {
  const { title, icon } = PROVIDERS[provider];
  draw(item, {
    text: `${prefix(provider, configuration)} $(loading~spin)`,
    tooltip: buildMessageTooltip(title, icon, "Reading usage…"),
    background: undefined,
  });
}

export function renderStatusBarItem(
  item: vscode.StatusBarItem,
  provider: ProviderId,
  view: ProviderView,
  configuration: ExtensionConfiguration,
  now = new Date(),
): void {
  const { title, icon } = PROVIDERS[provider];
  const mark = prefix(provider, configuration);
  const { snapshot } = view;
  if (!snapshot) {
    draw(item, {
      text: `${mark} --`,
      tooltip: buildMessageTooltip(title, icon, view.message ?? "No reading yet."),
      background: undefined,
    });
    return;
  }
  const age = formatAge(snapshot.fetchedAt, STALE_AFTER_MS, now);
  // A literal codicon, never the provider's own text, so a log value cannot alter the item.
  const blocked = snapshot.blocked ? "$(error) " : "";
  draw(item, {
    text: `${mark} ${blocked}${buildStatusText(snapshot, configuration, now)}${age ? " $(history)" : ""}`,
    tooltip: buildTooltip(
      title,
      icon,
      snapshot,
      configuration,
      view.message === null ? null : { message: view.message, verbatim: view.verbatim },
      age,
      now,
    ),
    background: BACKGROUNDS[pickSeverity(snapshot, configuration, now)],
  });
}

/** Everything about one item that a redraw could change, as the strings it was last given. */
interface Drawn {
  text: string;
  tooltip: string;
  background: vscode.ThemeColor | undefined;
}

const drawn = new WeakMap<vscode.StatusBarItem, Drawn>();

/**
 * Writing any property of a status bar item publishes the whole item, and the workbench answers a
 * published item by rebuilding its hover — which takes the tooltip out from under whoever is
 * reading it and does not put it back, because the pointer never left the item to ask again. The
 * countdowns are redrawn every few seconds and almost always come out identical, so what is drawn
 * last is remembered and an identical drawing is not a drawing at all.
 */
function draw(item: vscode.StatusBarItem, next: Drawn): void {
  const previous = drawn.get(item);
  if (
    previous &&
    previous.text === next.text &&
    previous.tooltip === next.tooltip &&
    previous.background === next.background
  ) {
    return;
  }
  drawn.set(item, next);
  item.text = next.text;
  item.tooltip = markdown(next.tooltip);
  item.backgroundColor = next.background;
  item.show();
}

/** Hiding disposes the item's entry, so the next drawing has to be a real one whatever it says. */
export function hideStatusBarItem(item: vscode.StatusBarItem): void {
  drawn.delete(item);
  item.hide();
}

/**
 * The three things the renderer will not do unasked: draw `$(icon)` as a codicon, keep the html the
 * bars and the dimmed text are made of, and follow a `command:` link.
 *
 * The first two are escaped against in `tooltip.ts`, which leaves every provider value as text
 * content — brackets, parentheses and angle brackets included, so no value can become a link of any
 * kind. That escaping is what the third rests on, because the narrower `{ enabledCommands }` form of
 * trust cannot be used here: it is a fresh object on every drawing, the workbench compares tooltips
 * by identity for that field, and an item whose tooltip never compares equal is an item whose hover
 * is torn down every time the minute on its countdown changes.
 */
function markdown(value: string): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(value);
  tooltip.isTrusted = true;
  tooltip.supportHtml = true;
  tooltip.supportThemeIcons = true;
  return tooltip;
}
