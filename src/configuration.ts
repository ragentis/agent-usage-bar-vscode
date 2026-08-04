/**
 * Settings as plain values, plus the rules that read them. Nothing here imports `vscode` — that
 * lives in `settings.ts` — which is what lets these rules be tested without an extension host.
 */

export type DisplayMode = "compact" | "full";
export type PercentageMode = "used" | "remaining";

export interface ExtensionConfiguration {
  displayMode: DisplayMode;
  percentageMode: PercentageMode;
  warningThreshold: number;
  errorThreshold: number;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  codexLabel: string;
  claudeLabel: string;
  refreshIntervalSeconds: number;
}

/**
 * Low enough to feel live, high enough that the account endpoints never rate limit us. It bounds
 * the poll setting and doubles as the floor under every automatic read, so no trigger and no
 * configured interval can put reads closer together than this.
 */
export const MIN_REFRESH_INTERVAL_SECONDS = 30;
export const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;

export const DEFAULT_WARNING_THRESHOLD = 80;
export const DEFAULT_ERROR_THRESHOLD = 95;

/** Long enough for a word or two, short enough that the item cannot be pushed off the bar. */
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

/**
 * One setting read, as `vscode.WorkspaceConfiguration.get` performs it. Taking the reader as an
 * argument is what keeps the bounding of hand-edited settings on this side of the vscode line.
 */
export type SettingReader = <T>(key: string, fallback: T) => T;

export function resolveConfiguration(read: SettingReader): ExtensionConfiguration {
  const warningThreshold = bounded(
    read("warningThreshold", DEFAULT_WARNING_THRESHOLD),
    DEFAULT_WARNING_THRESHOLD,
    0,
    100,
  );
  return {
    displayMode: read<DisplayMode>("displayMode", "compact"),
    percentageMode: read<PercentageMode>("percentageMode", "used"),
    warningThreshold,
    // The error background must never appear before the warning background.
    errorThreshold: Math.max(
      warningThreshold,
      bounded(read("errorThreshold", DEFAULT_ERROR_THRESHOLD), DEFAULT_ERROR_THRESHOLD, 0, 100),
    ),
    codexEnabled: read("codex.enabled", true),
    claudeEnabled: read("claude.enabled", true),
    codexLabel: label(read("codex.label", "")),
    claudeLabel: label(read("claude.label", "")),
    refreshIntervalSeconds: bounded(
      read("refreshIntervalSeconds", DEFAULT_REFRESH_INTERVAL_SECONDS),
      DEFAULT_REFRESH_INTERVAL_SECONDS,
      MIN_REFRESH_INTERVAL_SECONDS,
      MAX_REFRESH_INTERVAL_SECONDS,
    ),
  };
}

const PRESENTATION_KEYS = [
  "displayMode",
  "percentageMode",
  "warningThreshold",
  "errorThreshold",
  "claudeLabel",
  "codexLabel",
] as const satisfies readonly (keyof ExtensionConfiguration)[];

/**
 * Presentation-only edits must never trigger a provider read. Neither does the interval: it is
 * read afresh every time the due date of the next read is weighed, so a new one applies by being
 * written down and needs nothing done about it.
 */
export function configurationEffect(
  previous: ExtensionConfiguration,
  next: ExtensionConfiguration,
): "none" | "redraw" | "refresh" {
  if (
    previous.claudeEnabled !== next.claudeEnabled ||
    previous.codexEnabled !== next.codexEnabled
  ) {
    return "refresh";
  }
  return PRESENTATION_KEYS.some((key) => previous[key] !== next[key]) ? "redraw" : "none";
}
