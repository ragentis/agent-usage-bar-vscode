import * as vscode from "vscode";
import { providerEnabled, type ExtensionConfiguration } from "./configuration";
import { updateSetting } from "./settings";
import { PROVIDER_IDS, PROVIDER_NAMES, type ProviderId } from "./usage";

interface MenuItem extends vscode.QuickPickItem {
  action?: "settings" | "refresh";
  toggles?: ProviderId;
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
  // An enabled provider whose agent is not on this machine has no status bar item.
  const state = (provider: ProviderId): string => {
    if (!providerEnabled(configuration, provider)) {
      return "Off";
    }
    return hidden(provider) ? "Not found on this machine" : "On";
  };
  const choice = await vscode.window.showQuickPick<MenuItem>(
    [
      ...PROVIDER_IDS.map((provider) => ({
        label: `$(agent-usage-bar-${provider}) ${PROVIDER_NAMES[provider]}`,
        description: state(provider),
        toggles: provider,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(settings-gear) Open settings", action: "settings" },
      { label: "$(refresh) Refresh usage", action: "refresh" },
    ],
    { placeHolder: "Agent Usage Bar" },
  );
  if (choice?.toggles) {
    await updateSetting(
      `${choice.toggles}.enabled`,
      !providerEnabled(configuration, choice.toggles),
    );
    return;
  }
  switch (choice?.action) {
    case "settings":
      await openSettings(extensionId);
      break;
    case "refresh":
      await refresh();
      break;
  }
}
