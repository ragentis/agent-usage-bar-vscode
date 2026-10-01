import type { ExtensionConfiguration, PercentageMode } from "../core/configuration";
import type { UsageSnapshot, UsageWindow, WindowKind } from "../usage";
import { onPace } from "./pace";

export type Severity = "normal" | "warning" | "error";

const WINDOW_LABELS: Record<WindowKind, string> = { session: "5h", weekly: "7d" };

export interface ResolvedWindow extends UsageWindow {
  reset: boolean;
}

/**
 * A window past reset is stale: its recorded percentage no longer describes the current window.
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

export function formatPlan(plan: string): string {
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(plan)) {
    return plan;
  }
  return plan
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Retry waits use a fixed clock time because changing countdown text rebuilds and closes an open
 * hover. No wait outlives an hour, so the date is unnecessary.
 */
export function formatMoment(moment: Date, locale?: string): string {
  return moment.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

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
  const scope = window.label ? ` ${window.label}` : "";
  return `${WINDOW_LABELS[window.kind]}${scope} ${formatPercent(window.usedPercent, percentageMode)}${suffix}${remaining ? ` (${remaining})` : ""}`;
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
    // Showing every scope would make the item grow with the plan, so a scoped window is shown only
    // when its severity is not normal. The tooltip lists them all. A kind that has only scoped
    // windows shows its first one, which `sortWindows` made the most used.
    const whole = new Set(windows.filter((window) => !window.label).map((window) => window.kind));
    const leads = (window: ResolvedWindow): boolean =>
      !whole.has(window.kind) && windows.find(({ kind }) => kind === window.kind) === window;
    const shown = windows.filter(
      (window) =>
        !window.label ||
        leads(window) ||
        severityFor(window, configuration, snapshot.fetchedAt) !== "normal",
    );
    return (
      prefix +
      (shown.length > 0 ? shown : [primary])
        .map((window) => formatWindow(window, configuration.percentageMode, now))
        .join(" · ")
    );
  }
  // Compact shows the first window, but switches to the window that causes the warning color, so
  // a highlighted item shows the reason. Using `severityFor` for both keeps the swap and the color
  // consistent.
  const alarming = windows
    .filter((window) => severityFor(window, configuration, snapshot.fetchedAt) !== "normal")
    .toSorted((left, right) => right.usedPercent - left.usedPercent)[0];
  return prefix + formatWindow(alarming ?? primary, configuration.percentageMode, now);
}

/**
 * Shared by per-window tooltip bars and the worst-window status item so colors mean the same thing.
 * `asOf` is the reading timestamp rather than the clock, keeping any pace judgement aligned with the
 * percentage it is made about.
 */
export function severityFor(
  window: UsageWindow,
  configuration: ExtensionConfiguration,
  asOf: Date,
): Severity {
  if (window.usedPercent >= configuration.errorThreshold) {
    return "error";
  }
  if (window.usedPercent < configuration.warningThreshold) {
    return "normal";
  }
  // In `overPace` mode, usage that is not ahead of the window's elapsed time does not warn. The
  // error threshold above still applies at any pace.
  return configuration.warnWhen === "overPace" && onPace(window, asOf) ? "normal" : "warning";
}

const RANK: Record<Severity, number> = { normal: 0, warning: 1, error: 2 };

export function pickSeverity(
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  now = new Date(),
): Severity {
  // A blocked account is an error regardless of its percentages.
  if (snapshot.blocked) {
    return "error";
  }
  return resolveWindows(snapshot, now)
    .map((window) => severityFor(window, configuration, snapshot.fetchedAt))
    .reduce<Severity>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), "normal");
}
