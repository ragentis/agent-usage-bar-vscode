/**
 * Settings as plain values, plus the rules that read them. Nothing here imports `vscode`: the
 * reading and writing lives in `settings.ts`. That line is what lets these rules be exercised
 * by the unit tests, which run without an extension host.
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
