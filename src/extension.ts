import * as vscode from "vscode";
import { claudeSessionsPath } from "./claude";
import { fetchClaudeUsage } from "./claude-api";
import { codexSessionsPath } from "./codex";
import { CodexAppServer } from "./codex-appserver";
import { openSettings, showMenu } from "./menu";
import { ReadCoordinator } from "./read-coordinator";
import { affectsSettings, readConfiguration } from "./settings";
import { SharedUsageState } from "./shared-state";
import { createStatusBarItem, renderStatusBarItem, showLoading } from "./status-bar";
import { UsageBar, type ProviderDisplay, type ProviderPort } from "./usage-bar";
import type { ProviderId } from "./usage";
import { FileWatcher } from "./watcher";

/** Everything that reaches for vscode or for the machine lives here, and nowhere above it. */
function display(provider: ProviderId): ProviderDisplay {
  const item = createStatusBarItem(provider);
  return {
    render: (view, configuration) => renderStatusBarItem(item, provider, view, configuration),
    loading: (configuration) => showLoading(item, provider, configuration),
    hide: () => item.hide(),
    dispose: () => item.dispose(),
  };
}

function providers(onCodexPush: () => void): ProviderPort[] {
  // Transcript writes are only a "the agent just ran" signal; the numbers come from the services.
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
      // Built on the first read rather than up front, so a window that never reads Codex — because
      // another one is doing the reading — never starts the process either.
      read: () => (codexAppServer ??= new CodexAppServer(onCodexPush)).readUsage(),
      watcher: codexWatcher,
      isEnabled: (configuration) => configuration.codexEnabled,
      // A hidden item must not cost a running child process, and a stopped one sends no updates.
      stop: () => codexAppServer?.stop(),
      dispose: () => codexAppServer?.dispose(),
    },
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const reads = new ReadCoordinator(new SharedUsageState(context.globalState));
  // Codex pushes rate-limit updates of its own, so a port needs the bar that is built from the
  // ports. Closing over the binding is the whole of that knot, and the closure runs long after.
  // oxlint-disable-next-line prefer-const -- assigned on the next line, read only from the closure
  let usageBar: UsageBar;
  const ports = providers(() => void usageBar.refresh({ only: "codex" }));
  usageBar = new UsageBar(ports, reads, readConfiguration);

  context.subscriptions.push(
    usageBar,
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
      }
    }),
  );
  usageBar.start();
}

export function deactivate(): void {
  // Everything is released through the extension context subscriptions.
}
