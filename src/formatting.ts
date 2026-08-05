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
 * The moment a wait ends, stated rather than counted down. A countdown would be the more natural
 * thing to write and is the reason this is not one: it would move under a reader — the tooltip is
 * redrawn every few seconds, and the workbench answers a tooltip that has changed by rebuilding
 * the hover it is showing, which closes it. No wait outlives an hour here, so the time of day says
 * it all without a date beside it.
 */
export function formatMoment(moment: Date, locale?: string): string {
  return moment.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
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

/**
 * One percentage against the two thresholds. The item colors itself from the worst window it has,
 * while the tooltip colors each window's bar from that window alone, and both mean the same thing
 * by a color only because they ask this.
 */
export function severityFor(usedPercent: number, configuration: ExtensionConfiguration): Severity {
  if (usedPercent >= configuration.errorThreshold) {
    return "error";
  }
  return usedPercent >= configuration.warningThreshold ? "warning" : "normal";
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
  return severityFor(
    Math.max(0, ...resolveWindows(snapshot, now).map((window) => window.usedPercent)),
    configuration,
  );
}
