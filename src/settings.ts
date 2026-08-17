import * as vscode from "vscode";
import { resolveConfiguration, type ExtensionConfiguration, type ThemeKind } from "./configuration";

const SECTION = "agentUsageBar";

export type WritableSetting = "claude.enabled" | "codex.enabled";

/** Both high-contrast kinds resolve with their light or dark counterpart. */
function themeKind(): ThemeKind {
  const { kind } = vscode.window.activeColorTheme;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? "light"
    : "dark";
}

export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return resolveConfiguration((key, fallback) => configuration.get(key, fallback), themeKind());
}

export function updateSetting(key: WritableSetting, value: boolean): Thenable<void> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
