import * as vscode from "vscode";
import { confirmAbsence } from "./core/presence";
import { ReadCoordinator } from "./core/read-coordinator";
import { affectsSettings, readConfiguration } from "./core/settings";
import { SharedUsageState } from "./core/shared-state";
import { UsageBar, type ProviderDisplay, type ProviderPort } from "./core/usage-bar";
import { FileWatcher } from "./core/watcher";
import { HistoryService } from "./history/history-service";
import { UsageHistoryState } from "./history/history-store";
import { AntigravityHistory } from "./providers/antigravity/antigravity-history";
import { AntigravityHub } from "./providers/antigravity/antigravity-hub";
import { realWritesOnly } from "./providers/antigravity/antigravity-watcher";
import {
  antigravityConversationsPath,
  antigravityDirectory,
} from "./providers/antigravity/antigravity";
import { fetchClaudeUsage } from "./providers/claude/claude-api";
import { nativeCliVersions, newestCliVersion } from "./providers/claude/claude-cli-version";
import { scanClaudeHistory } from "./providers/claude/claude-history";
import { claudeDirectory, claudeSessionsPath } from "./providers/claude/claude";
import { CodexAppServer } from "./providers/codex/codex-appserver";
import { scanCodexHistory } from "./providers/codex/codex-history";
import { codexDirectory, codexSessionsPath } from "./providers/codex/codex";
import { openSettings, showMenu } from "./ui/menu";
import {
  createStatusBarItem,
  hideStatusBarItem,
  renderStatusBarItem,
  showLoading,
} from "./ui/status-bar";
import type { ProviderId } from "./usage";
import { isRecord } from "./validation";

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
    {
      claude: (since) => scanClaudeHistory(since),
      codex: (since, stored) => scanCodexHistory(since, stored?.last ?? null),
      antigravity: (since, stored) => antigravityHistory.scan(since, stored?.scannedAt ?? 0),
    },
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
