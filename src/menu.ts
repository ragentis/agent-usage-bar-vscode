import * as vscode from "vscode";
import type { ExtensionConfiguration } from "./configuration";
import { updateSetting } from "./settings";

interface MenuItem extends vscode.QuickPickItem {
  action?: "toggleClaude" | "toggleCodex" | "settings" | "refresh";
}

/** Derived rather than written down: a hard-coded publisher stops matching when it changes. */
export function openSettings(extensionId: string): Thenable<unknown> {
  return vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionId}`);
}

/**
 * The toggles are written straight to settings rather than held here, so the change event is the
 * single path back into the status bar however the setting was edited.
 */
export async function showMenu(
  configuration: ExtensionConfiguration,
  extensionId: string,
  refresh: () => Promise<void>,
): Promise<void> {
  const state = (enabled: boolean): string => (enabled ? "On" : "Off");
  const choice = await vscode.window.showQuickPick<MenuItem>(
    [
      {
        label: "$(agent-usage-bar-claude) Claude Code",
        description: state(configuration.claudeEnabled),
        action: "toggleClaude",
      },
      {
        label: "$(agent-usage-bar-codex) Codex",
        description: state(configuration.codexEnabled),
        action: "toggleCodex",
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
    case "settings":
      await openSettings(extensionId);
      break;
    case "refresh":
      await refresh();
      break;
  }
}
