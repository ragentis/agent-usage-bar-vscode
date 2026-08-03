import * as vscode from "vscode";
import type { ExtensionConfiguration } from "./configuration";
import {
  buildStatusText,
  formatAge,
  formatPercent,
  formatRemaining,
  pickSeverity,
  resolveWindows,
  type Severity,
} from "./formatting";
import type { ProviderId, ProviderView, SnapshotSource, UsageSnapshot, WindowKind } from "./usage";

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

const WINDOW_TITLES: Record<WindowKind, string> = { session: "5-hour", weekly: "Weekly" };

const SOURCE_TITLES: Record<SnapshotSource, string> = {
  "claude-account-api": "Claude account",
  "codex-app-server": "Codex account",
};

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
    item.tooltip = buildTooltip(title, snapshot, configuration, view.message, age, now);
    item.backgroundColor = BACKGROUNDS[pickSeverity(snapshot, configuration, now)];
  } else {
    item.text = `${mark} --`;
    item.tooltip = `${title}: ${view.message ?? "no reading yet"}`;
    item.backgroundColor = undefined;
  }
  item.show();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

function meter(usedPercent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(usedPercent / 10)));
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildTooltip(
  title: string,
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  failure: string | null,
  age: string | null,
  now = new Date(),
): vscode.MarkdownString {
  const { percentageMode } = configuration;
  const plan = snapshot.plan ? ` · Plan: ${escapeMarkdown(snapshot.plan)}` : "";
  const modeLabel = percentageMode === "remaining" ? " remaining" : " used";
  const windows = resolveWindows(snapshot, now);
  const lines = [`**${escapeMarkdown(title)}**${plan}`];
  if (snapshot.blocked) {
    lines.push(`**${escapeMarkdown(snapshot.blocked)}**`);
  }
  for (const window of windows) {
    const reset = window.reset
      ? " · reset since this reading"
      : window.resetsAt
        ? ` · resets ${formatRemaining(window.resetsAt, now) ?? "soon"} (${escapeMarkdown(formatDate(window.resetsAt))})`
        : "";
    lines.push(
      `${WINDOW_TITLES[window.kind]}: ${meter(window.usedPercent)} **${formatPercent(window.usedPercent, percentageMode)}**${modeLabel}${reset}`,
    );
  }
  if (snapshot.credits) {
    lines.push(`Credits: ${escapeMarkdown(snapshot.credits)}`);
  }
  lines.push(
    `From ${SOURCE_TITLES[snapshot.source]} · as of ${escapeMarkdown(formatDate(snapshot.fetchedAt))}${age ? ` (${age})` : ""}`,
  );
  if (failure) {
    lines.push(`$(warning) Last refresh failed: ${escapeMarkdown(failure)}`);
  }
  if (windows.some((window) => window.reset)) {
    lines.push(
      "\\~ marks a window assumed empty after its reset; run the agent for a confirmed reading.",
    );
  }

  const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
  tooltip.isTrusted = false;
  tooltip.supportHtml = false;
  // Codicons in a tooltip render only when the string opts in; without this `$(warning)` is text.
  // Every value interpolated above goes through `escapeMarkdown`, so no reading can inject one.
  tooltip.supportThemeIcons = true;
  return tooltip;
}
