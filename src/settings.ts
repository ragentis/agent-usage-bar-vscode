import * as vscode from "vscode";
import {
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_REFRESH_INTERVAL_SECONDS,
  type DisplayMode,
  type ExtensionConfiguration,
  type PercentageMode,
} from "./configuration";

/** Named once, so a section rename cannot half-apply across reads, writes, and change events. */
const SECTION = "agentUsageBar";

/** The only settings written from inside the extension; the rest are edited in the settings UI. */
export type WritableSetting = "claude.enabled" | "codex.enabled";

const MAX_LABEL_LENGTH = 24;

/** Keeps a hand-edited setting from stretching the status bar or smuggling in newlines. */
function label(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH)
    : "";
}

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function readConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const warningThreshold = bounded(configuration.get("warningThreshold", 80), 80, 0, 100);
  return {
    displayMode: configuration.get<DisplayMode>("displayMode", "compact"),
    percentageMode: configuration.get<PercentageMode>("percentageMode", "used"),
    warningThreshold,
    // The error background must never appear before the warning background.
    errorThreshold: Math.max(
      warningThreshold,
      bounded(configuration.get("errorThreshold", 95), 95, 0, 100),
    ),
    codexEnabled: configuration.get("codex.enabled", true),
    claudeEnabled: configuration.get("claude.enabled", true),
    codexLabel: label(configuration.get("codex.label", "")),
    claudeLabel: label(configuration.get("claude.label", "")),
    refreshIntervalSeconds: bounded(
      configuration.get("refreshIntervalSeconds", DEFAULT_REFRESH_INTERVAL_SECONDS),
      DEFAULT_REFRESH_INTERVAL_SECONDS,
      MIN_REFRESH_INTERVAL_SECONDS,
      MAX_REFRESH_INTERVAL_SECONDS,
    ),
  };
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
