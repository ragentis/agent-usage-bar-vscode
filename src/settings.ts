import * as vscode from "vscode";
import { resolveConfiguration, type ExtensionConfiguration } from "./configuration";

/** Named once, so a section rename cannot half-apply across reads, writes, and change events. */
const SECTION = "agentUsageBar";

/** The only settings written from inside the extension; the rest are edited in the settings UI. */
export type WritableSetting = "claude.enabled" | "codex.enabled";

/** The host half of the reading: which section, and nothing about what the values may be. */
export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return resolveConfiguration((key, fallback) => configuration.get(key, fallback));
}

/** Global, because usage belongs to the account rather than to whichever folder is open. */
export function updateSetting(key: WritableSetting, value: boolean): Thenable<void> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
