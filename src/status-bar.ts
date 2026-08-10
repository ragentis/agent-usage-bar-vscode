import * as vscode from "vscode";
import type { ExtensionConfiguration } from "./configuration";
import { buildStatusText, formatAge, pickSeverity, type Severity } from "./formatting";
import { buildMessageTooltip, buildTooltip } from "./tooltip";
import type { ProviderId, ProviderView } from "./usage";

/**
 * Priorities just above the commonly used 100 keep the provider items adjacent when possible;
 * VS Code offers no grouping API.
 *
 * Tooltip icons use lifted font variants because Markdown baseline alignment places the status-bar
 * glyphs too low and the sanitizer disallows vertical positioning.
 */
const PROVIDERS: Record<
  ProviderId,
  { title: string; icon: string; hoverIcon: string; priority: number }
> = {
  claude: {
    title: "Claude Code usage",
    icon: "agent-usage-bar-claude",
    hoverIcon: "agent-usage-bar-claude-hover",
    priority: 100.02,
  },
  codex: {
    title: "Codex usage",
    icon: "agent-usage-bar-codex",
    hoverIcon: "agent-usage-bar-codex-hover",
    priority: 100.01,
  },
};

function prefix(provider: ProviderId, configuration: ExtensionConfiguration): string {
  const label = provider === "claude" ? configuration.claudeLabel : configuration.codexLabel;
  return label || `$(${PROVIDERS[provider].icon})`;
}

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
  const { title, hoverIcon } = PROVIDERS[provider];
  draw(item, {
    text: `${prefix(provider, configuration)} $(loading~spin)`,
    tooltip: buildMessageTooltip(title, hoverIcon, "Reading usage…"),
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
  const { title, hoverIcon } = PROVIDERS[provider];
  const mark = prefix(provider, configuration);
  const { snapshot } = view;
  if (!snapshot) {
    draw(item, {
      text: `${mark} --`,
      tooltip: buildMessageTooltip(title, hoverIcon, view.message ?? "No reading yet."),
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
      hoverIcon,
      snapshot,
      configuration,
      view.message === null ? null : { message: view.message, verbatim: view.verbatim },
      age,
      now,
    ),
    background: BACKGROUNDS[pickSeverity(snapshot, configuration, now)],
  });
}

interface Drawn {
  text: string;
  tooltip: string;
  background: vscode.ThemeColor | undefined;
}

const drawn = new WeakMap<vscode.StatusBarItem, Drawn>();

/**
 * Updating any item property rebuilds and closes an open hover. Cache the last drawing because the
 * frequent countdown tick usually produces identical output.
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

export function hideStatusBarItem(item: vscode.StatusBarItem): void {
  drawn.delete(item);
  item.hide();
}

/**
 * Trusted Markdown is required for command links, HTML, and theme icons. `tooltip.ts` escapes all
 * provider values before they reach this boundary, so only extension-authored commands remain.
 * Using a fresh `{ enabledCommands }` object would also defeat tooltip equality and close the hover
 * on redraw.
 */
function markdown(value: string): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(value);
  tooltip.isTrusted = true;
  tooltip.supportHtml = true;
  tooltip.supportThemeIcons = true;
  return tooltip;
}
