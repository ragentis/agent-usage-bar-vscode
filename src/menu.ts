import * as vscode from "vscode";
import type { ExtensionConfiguration } from "./configuration";
import { updateSetting } from "./settings";
import type { ProviderId } from "./usage";

interface MenuItem extends vscode.QuickPickItem {
  action?: "toggleClaude" | "toggleCodex" | "toggleAntigravity" | "settings" | "refresh";
}

export function openSettings(extensionId: string): Thenable<unknown> {
  return vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionId}`);
}

export async function showMenu(
  configuration: ExtensionConfiguration,
  extensionId: string,
  refresh: () => Promise<void>,
  hidden: (provider: ProviderId) => boolean,
): Promise<void> {
  // An enabled provider whose agent is not on this machine has no item to point at.
  const state = (provider: ProviderId, enabled: boolean): string => {
    if (!enabled) {
      return "Off";
    }
    return hidden(provider) ? "Not found on this machine" : "On";
  };
  const choice = await vscode.window.showQuickPick<MenuItem>(
    [
      {
        label: "$(agent-usage-bar-claude) Claude Code",
        description: state("claude", configuration.claudeEnabled),
        action: "toggleClaude",
      },
      {
        label: "$(agent-usage-bar-codex) Codex",
        description: state("codex", configuration.codexEnabled),
        action: "toggleCodex",
      },
      {
        label: "$(agent-usage-bar-antigravity) Antigravity",
        description: state("antigravity", configuration.antigravityEnabled),
        action: "toggleAntigravity",
      },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(settings-gear) Open settings", action: "settings" },
      { label: "$(refresh) Refresh usage", action: "refresh" },
    ],
    { placeHolder: "Agent Usage Bar" },
  );
  switch (choice?.action) {
    case "toggleClaude":
      await updateSetting("claude.enabled", !configuration.claudeEnabled);
      break;
    case "toggleCodex":
      await updateSetting("codex.enabled", !configuration.codexEnabled);
      break;
    case "toggleAntigravity":
      await updateSetting("antigravity.enabled", !configuration.antigravityEnabled);
      break;
    case "settings":
      await openSettings(extensionId);
      break;
    case "refresh":
      await refresh();
      break;
  }
}
