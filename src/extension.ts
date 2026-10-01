import * as vscode from "vscode";
import { antigravityConversationsPath, antigravityDirectory } from "./antigravity";
import { AntigravityHistory, realWritesOnly } from "./antigravity-history";
import { AntigravityHub } from "./antigravity-hub";
import { claudeDirectory, claudeSessionsPath, nativeCliVersions } from "./claude";
import { fetchClaudeUsage, newestCliVersion } from "./claude-api";
import { codexDirectory, codexSessionsPath } from "./codex";
import { CodexAppServer } from "./codex-appserver";
import { HistoryService } from "./history-service";
import { UsageHistoryState } from "./history-store";
import { openSettings, showMenu } from "./menu";
import { confirmAbsence } from "./presence";
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
import { isRecord, type ProviderId } from "./usage";
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

async function claudeCliVersion(): Promise<string> {
  const extension = vscode.extensions.getExtension<unknown>("anthropic.claude-code");
  const manifest: unknown = extension?.packageJSON;
  const bundled = isRecord(manifest) ? manifest.version : null;
  return newestCliVersion([bundled, ...(await nativeCliVersions())]);
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
  // A conversation in use is written to its log, not its database, so every file is watched. The
  // wrapper filters out the empty files a history scan leaves behind.
  const antigravityWatcher = realWritesOnly(
    new FileWatcher({
      directory: antigravityConversationsPath(),
      fileSuffix: "",
      recursive: false,
    }),
  );
  let codexAppServer: CodexAppServer | null = null;
  let antigravityHub: AntigravityHub | null = null;
  const claudeRequest = { plainOnly: false };
  return [
    {
      id: "claude",
      display: display("claude"),
      read: async () =>
        confirmAbsence(
          await fetchClaudeUsage(undefined, await claudeCliVersion(), claudeRequest),
          claudeDirectory(),
        ),
      watcher: claudeWatcher,
      isEnabled: (configuration) => configuration.claudeEnabled,
    },
    {
      id: "codex",
      display: display("codex"),
      // Lazy startup avoids a Codex process in windows that only adopt another window's readings.
      read: async () =>
        confirmAbsence(
          await (codexAppServer ??= new CodexAppServer(onCodexPush)).readUsage(),
          codexDirectory(),
        ),
      watcher: codexWatcher,
      isEnabled: (configuration) => configuration.codexEnabled,
      stop: () => codexAppServer?.stop(),
      dispose: () => codexAppServer?.dispose(),
    },
    {
      id: "antigravity",
      display: display("antigravity"),
      read: async () =>
        confirmAbsence(
          await (antigravityHub ??= new AntigravityHub()).readUsage(),
          antigravityDirectory(),
        ),
      watcher: antigravityWatcher,
      isEnabled: (configuration) => configuration.antigravityEnabled,
      stop: () => antigravityHub?.stop(),
      dispose: () => antigravityHub?.dispose(),
    },
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const reads = new ReadCoordinator(new SharedUsageState(context.globalState));
  // Codex push updates need the UsageBar constructed from this port.
  // oxlint-disable-next-line prefer-const -- assigned on the next line, read only from the closure
  let usageBar: UsageBar;
  const ports = providers(() => void usageBar.refresh({ only: "codex" }));
  // History scans use a separate hub, so stopping a usage read does not stop a scan.
  const antigravityScans = new AntigravityHub();
  const antigravityHistory = new AntigravityHistory((use) => antigravityScans.query(use));
  const history = new HistoryService(
    new UsageHistoryState(context.globalState),
    (provider, totals) => usageBar.setHistory(provider, totals),
    readConfiguration,
    (since, scannedAt) => antigravityHistory.scan(since, scannedAt),
  );
  usageBar = new UsageBar(ports, reads, readConfiguration, (provider) =>
    history.handleActivity(provider),
  );

  context.subscriptions.push(
    usageBar,
    history,
    { dispose: () => antigravityScans.dispose() },
    vscode.window.onDidChangeActiveColorTheme(() => usageBar.handleConfigurationChange()),
    vscode.commands.registerCommand("agentUsageBar.refresh", () =>
      usageBar.refresh({ showLoading: true, force: true }),
    ),
    vscode.commands.registerCommand("agentUsageBar.openMenu", () =>
      showMenu(
        usageBar.settings,
        context.extension.id,
        () => usageBar.refresh({ showLoading: true, force: true }),
        (provider) => usageBar.isHidden(provider),
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
