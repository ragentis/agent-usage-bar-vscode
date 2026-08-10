import * as vscode from "vscode";
import { resolveConfiguration, type ExtensionConfiguration } from "./configuration";

const SECTION = "agentUsageBar";

export type WritableSetting = "claude.enabled" | "codex.enabled";

export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return resolveConfiguration((key, fallback) => configuration.get(key, fallback));
}

export function updateSetting(key: WritableSetting, value: boolean): Thenable<void> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
