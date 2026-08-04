import * as vscode from "vscode";
import type { ExtensionConfiguration } from "./configuration";
import { buildStatusText, formatAge, pickSeverity, type Severity } from "./formatting";
import { buildTooltipLines } from "./tooltip";
import type { ProviderId, ProviderView } from "./usage";

/**
 * Status bar order is priority descending, and there is no API to keep two items together.
 * Round priorities such as 100 are what most extensions pick, so anything landing on one of
 * those would split the pair. These sit just off a round value with almost no gap between
 * them, which leaves no room for a foreign item to be sorted in between.
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

/** Past this the reading is old enough that the user should be told rather than trusted. */
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
  const { title } = PROVIDERS[provider];
  item.text = `${prefix(provider, configuration)} $(loading~spin)`;
  item.tooltip = `${title}: loading`;
  item.backgroundColor = undefined;
  item.show();
}

export function renderStatusBarItem(
  item: vscode.StatusBarItem,
  provider: ProviderId,
  view: ProviderView,
  configuration: ExtensionConfiguration,
  now = new Date(),
): void {
  const { title } = PROVIDERS[provider];
  const mark = prefix(provider, configuration);
  const { snapshot } = view;
  if (snapshot) {
    const age = formatAge(snapshot.fetchedAt, STALE_AFTER_MS, now);
    // A literal codicon, never the provider's own text, so a log value cannot alter the item.
    const blocked = snapshot.blocked ? "$(error) " : "";
    item.text = `${mark} ${blocked}${buildStatusText(snapshot, configuration, now)}${age ? " $(history)" : ""}`;
    item.tooltip = markdown(
      buildTooltipLines(title, snapshot, configuration, view.message, age, now),
    );
    item.backgroundColor = BACKGROUNDS[pickSeverity(snapshot, configuration, now)];
  } else {
    item.text = `${mark} --`;
    item.tooltip = `${title}: ${view.message ?? "no reading yet"}`;
    item.backgroundColor = undefined;
  }
  item.show();
}

/**
 * The flags decide how the lines are read, so they belong beside the wrapping rather than beside
 * the writing. Codicons in a tooltip render only when the string opts in; without the last one
 * `$(warning)` is text. Every value the lines interpolate is escaped by `buildTooltipLines`,
 * parentheses included, so nothing a provider says can arrive here as a codicon or as markup.
 */
function markdown(lines: string[]): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
  tooltip.isTrusted = false;
  tooltip.supportHtml = false;
  tooltip.supportThemeIcons = true;
  return tooltip;
}
