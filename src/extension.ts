import * as vscode from "vscode";
import { claudeSessionsPath } from "./claude";
import { fetchClaudeUsage } from "./claude-api";
import { codexSessionsPath } from "./codex";
import { CodexAppServer } from "./codex-appserver";
import { HistoryService } from "./history-service";
import { UsageHistoryState } from "./history-store";
import { openSettings, showMenu } from "./menu";
import { ReadCoordinator } from "./read-coordinator";
import { affectsSettings, readConfiguration } from "./settings";
import { SharedUsageState } from "./shared-state";
import {
  createStatusBarItem,
  hideStatusBarItem,
  renderStatusBarItem,
  showLoading,
} from "./status-bar";
import { UsageBar, type ProviderDisplay, type ProviderPort } from "./usage-bar";
import type { ProviderId } from "./usage";
import { FileWatcher } from "./watcher";

function display(provider: ProviderId): ProviderDisplay {
  const item = createStatusBarItem(provider);
  return {
    render: (view, configuration, history) =>
      renderStatusBarItem(item, provider, view, configuration, history),
    loading: (configuration) => showLoading(item, provider, configuration),
    hide: () => hideStatusBarItem(item),
    dispose: () => item.dispose(),
  };
}

function providers(onCodexPush: () => void): ProviderPort[] {
  const claudeWatcher = new FileWatcher({
    directory: claudeSessionsPath(),
    fileSuffix: ".jsonl",
    recursive: true,
  });
  const codexWatcher = new FileWatcher({
    directory: codexSessionsPath(),
    fileSuffix: ".jsonl",
    recursive: true,
  });
  let codexAppServer: CodexAppServer | null = null;
  return [
    {
      id: "claude",
      display: display("claude"),
      read: () => fetchClaudeUsage(),
      watcher: claudeWatcher,
      isEnabled: (configuration) => configuration.claudeEnabled,
    },
    {
      id: "codex",
      display: display("codex"),
      // Lazy startup avoids a Codex process in windows that only adopt another window's readings.
      read: () => (codexAppServer ??= new CodexAppServer(onCodexPush)).readUsage(),
      watcher: codexWatcher,
      isEnabled: (configuration) => configuration.codexEnabled,
      stop: () => codexAppServer?.stop(),
      dispose: () => codexAppServer?.dispose(),
    },
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const reads = new ReadCoordinator(new SharedUsageState(context.globalState));
  // Codex push updates need the UsageBar constructed from this port.
  // oxlint-disable-next-line prefer-const -- assigned on the next line, read only from the closure
  let usageBar: UsageBar;
  const ports = providers(() => void usageBar.refresh({ only: "codex" }));
  const history = new HistoryService(
    new UsageHistoryState(context.globalState),
    (provider, totals) => usageBar.setHistory(provider, totals),
    readConfiguration,
  );
  usageBar = new UsageBar(ports, reads, readConfiguration, (provider) =>
    history.handleActivity(provider),
  );

  context.subscriptions.push(
    usageBar,
    history,
    vscode.window.onDidChangeActiveColorTheme(() => usageBar.handleConfigurationChange()),
    vscode.commands.registerCommand("agentUsageBar.refresh", () =>
      usageBar.refresh({ showLoading: true, force: true }),
    ),
    vscode.commands.registerCommand("agentUsageBar.openMenu", () =>
      showMenu(usageBar.settings, context.extension.id, () =>
        usageBar.refresh({ showLoading: true, force: true }),
      ),
    ),
    vscode.commands.registerCommand("agentUsageBar.openSettings", () =>
      openSettings(context.extension.id),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsSettings(event)) {
        usageBar.handleConfigurationChange();
        history.handleConfigurationChange();
      }
    }),
  );
  usageBar.start();
  history.start();
}

export function deactivate(): void {
  // Resources are owned by extension context subscriptions.
}
