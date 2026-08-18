/**
 * Settings and validation stay independent of `vscode`; only `settings.ts` crosses the host boundary.
 */

export type DisplayMode = "compact" | "full";
export type PercentageMode = "used" | "remaining";
export type WarnWhen = "threshold" | "overPace";
/** Not a setting: the strip's hue is written out per theme; theme colors carry no opacity. */
export type ThemeKind = "light" | "dark";

export interface ExtensionConfiguration {
  displayMode: DisplayMode;
  percentageMode: PercentageMode;
  locale: string | undefined;
  showPace: boolean;
  warningThreshold: number;
  errorThreshold: number;
  warnWhen: WarnWhen;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  codexLabel: string;
  claudeLabel: string;
  refreshIntervalSeconds: number;
  showHistory: boolean;
  theme: ThemeKind;
}

/**
 * This bounds both the setting and every automatic trigger. Neither provider publishes its limit,
 * so `Retry-After` still controls any refusal. The account endpoint is shared with the agent itself
 * and every other client, and a transcript-driven read every half minute was enough to be refused.
 */
export const MIN_REFRESH_INTERVAL_SECONDS = 60;
export const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;

export const DEFAULT_WARNING_THRESHOLD = 80;
export const DEFAULT_ERROR_THRESHOLD = 95;

const MAX_LABEL_LENGTH = 24;

function label(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH)
    : "";
}

/**
 * VS Code's default follows its display language rather than OS regional settings.
 * `supportedLocalesOf` validates and canonicalizes before the value reaches `toLocaleString`.
 */
function locale(value: unknown): string | undefined {
  const tag = typeof value === "string" ? value.trim() : "";
  if (!tag) {
    return undefined;
  }
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(tag)[0];
  } catch {
    return undefined;
  }
}

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export type SettingReader = <T>(key: string, fallback: T) => T;

export function resolveConfiguration(
  read: SettingReader,
  theme: ThemeKind = "dark",
): ExtensionConfiguration {
  const warningThreshold = bounded(
    read("warningThreshold", DEFAULT_WARNING_THRESHOLD),
    DEFAULT_WARNING_THRESHOLD,
    0,
    100,
  );
  return {
    displayMode: read<DisplayMode>("displayMode", "compact"),
    percentageMode: read<PercentageMode>("percentageMode", "used"),
    locale: locale(read("locale", "")),
    showPace: read("showPace", true),
    warningThreshold,
    // The error background must never appear before the warning background.
    errorThreshold: Math.max(
      warningThreshold,
      bounded(read("errorThreshold", DEFAULT_ERROR_THRESHOLD), DEFAULT_ERROR_THRESHOLD, 0, 100),
    ),
    warnWhen: read<WarnWhen>("warnWhen", "threshold"),
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
    showHistory: read("showHistory", true),
    theme,
  };
}

const PRESENTATION_KEYS = [
  "displayMode",
  "percentageMode",
  "locale",
  "showPace",
  "warningThreshold",
  "errorThreshold",
  "warnWhen",
  "claudeLabel",
  "codexLabel",
  "showHistory",
  "theme",
] as const satisfies readonly (keyof ExtensionConfiguration)[];

/**
 * Only source changes require fresh provider data. The interval is read again whenever due time is
 * calculated, so changing it needs no immediate refresh.
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
