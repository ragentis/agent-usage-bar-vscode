import type { ExtensionConfiguration, PercentageMode } from "./configuration";
import type { UsageSnapshot, UsageWindow, WindowKind } from "./usage";

export type Severity = "normal" | "warning" | "error";

const WINDOW_LABELS: Record<WindowKind, string> = { session: "5h", weekly: "7d" };

export interface ResolvedWindow extends UsageWindow {
  reset: boolean;
}

/**
 * A window whose reset time has passed means the snapshot predates a refill: the recorded
 * percentage is no longer true, and the real one stays unknown until the agent runs again.
 */
export function resolveWindows(snapshot: UsageSnapshot, now = new Date()): ResolvedWindow[] {
  return snapshot.windows.map((window) =>
    window.resetsAt && window.resetsAt.getTime() <= now.getTime()
      ? { ...window, usedPercent: 0, resetsAt: null, reset: true }
      : { ...window, reset: false },
  );
}

export function formatPercent(usedPercent: number, mode: PercentageMode): string {
  return `${Math.round(mode === "remaining" ? 100 - usedPercent : usedPercent)}%`;
}

export function formatRemaining(resetsAt: Date | null, now = new Date()): string | null {
  if (!resetsAt) {
    return null;
  }
  const totalMinutes = Math.floor((resetsAt.getTime() - now.getTime()) / 60_000);
  if (totalMinutes <= 0) {
    return "reset due";
  }
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * A retry window is short in a way a quota window never is, so "reset due" would be wrong here and
 * seconds are worth printing. Rounds up, so it never prints `0s` while still waiting.
 */
export function formatWait(until: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1_000));
  return seconds < 60 ? `${seconds}s` : (formatRemaining(until, now) ?? `${seconds}s`);
}

/** Null while the reading is still current, so the tooltip only mentions age once it matters. */
export function formatAge(fetchedAt: Date, staleAfterMs: number, now = new Date()): string | null {
  const elapsed = now.getTime() - fetchedAt.getTime();
  if (elapsed < staleAfterMs) {
    return null;
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function formatWindow(
  window: UsageWindow,
  percentageMode: PercentageMode,
  now = new Date(),
): string {
  const remaining = formatRemaining(window.resetsAt, now);
  const suffix = percentageMode === "remaining" ? " left" : "";
  return `${WINDOW_LABELS[window.kind]} ${formatPercent(window.usedPercent, percentageMode)}${suffix}${remaining ? ` (${remaining})` : ""}`;
}

export function buildStatusText(
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  now = new Date(),
): string {
  const windows = resolveWindows(snapshot, now);
  const primary = windows[0];
  if (!primary) {
    return "--";
  }
  const prefix = windows.some((window) => window.reset) ? "~" : "";
  if (configuration.displayMode === "full") {
    return (
      prefix +
      windows.map((window) => formatWindow(window, configuration.percentageMode, now)).join(" · ")
    );
  }
  // Compact normally shows the shortest window, but switches to whichever window drives the
  // warning color so a highlighted status bar always explains itself.
  const alarming = windows
    .filter((window) => window.usedPercent >= configuration.warningThreshold)
    .toSorted((left, right) => right.usedPercent - left.usedPercent)[0];
  return prefix + formatWindow(alarming ?? primary, configuration.percentageMode, now);
}

export function pickSeverity(
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  now = new Date(),
): Severity {
  // A stopped account is the one case where the percentage says nothing useful.
  if (snapshot.blocked) {
    return "error";
  }
  const maximum = Math.max(0, ...resolveWindows(snapshot, now).map((window) => window.usedPercent));
  if (maximum >= configuration.errorThreshold) {
    return "error";
  }
  return maximum >= configuration.warningThreshold ? "warning" : "normal";
}
