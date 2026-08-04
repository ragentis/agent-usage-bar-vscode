import type { ExtensionConfiguration } from "./configuration";
import { formatPercent, formatRemaining, resolveWindows } from "./formatting";
import type { SnapshotSource, UsageSnapshot, WindowKind } from "./usage";

/**
 * The tooltip is the one surface where what a provider said is drawn rather than counted: a plan
 * name, a reason the account is stopped, a credit balance, and the reason the last read failed all
 * reach it as text. It renders as markdown with theme icons turned on, so each of them is escaped
 * on the way in. Lines rather than a `MarkdownString`, so the escaping is a string a test can read
 * and `status-bar.ts` is left holding nothing but the wrapping.
 */

const WINDOW_TITLES: Record<WindowKind, string> = { session: "5-hour", weekly: "Weekly" };

const SOURCE_TITLES: Record<SnapshotSource, string> = {
  "claude-account-api": "Claude account",
  "codex-app-server": "Codex account",
};

/**
 * Every markdown metacharacter, plus the parentheses that would otherwise let `$(icon)` through as
 * a codicon rather than as the text it is.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

function meter(usedPercent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(usedPercent / 10)));
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildTooltipLines(
  title: string,
  snapshot: UsageSnapshot,
  configuration: ExtensionConfiguration,
  failure: string | null,
  age: string | null,
  now = new Date(),
): string[] {
  const { percentageMode } = configuration;
  const plan = snapshot.plan ? ` · Plan: ${escapeMarkdown(snapshot.plan)}` : "";
  const modeLabel = percentageMode === "remaining" ? " remaining" : " used";
  const windows = resolveWindows(snapshot, now);
  const lines = [`**${escapeMarkdown(title)}**${plan}`];
  if (snapshot.blocked) {
    lines.push(`**${escapeMarkdown(snapshot.blocked)}**`);
  }
  for (const window of windows) {
    const reset = window.reset
      ? " · reset since this reading"
      : window.resetsAt
        ? ` · resets ${formatRemaining(window.resetsAt, now) ?? "soon"} (${escapeMarkdown(formatDate(window.resetsAt))})`
        : "";
    lines.push(
      `${WINDOW_TITLES[window.kind]}: ${meter(window.usedPercent)} **${formatPercent(window.usedPercent, percentageMode)}**${modeLabel}${reset}`,
    );
  }
  if (snapshot.credits) {
    lines.push(`Credits: ${escapeMarkdown(snapshot.credits)}`);
  }
  lines.push(
    `From ${SOURCE_TITLES[snapshot.source]} · as of ${escapeMarkdown(formatDate(snapshot.fetchedAt))}${age ? ` (${age})` : ""}`,
  );
  if (failure) {
    lines.push(`$(warning) Last refresh failed: ${escapeMarkdown(failure)}`);
  }
  if (windows.some((window) => window.reset)) {
    lines.push(
      "\\~ marks a window assumed empty after its reset; run the agent for a confirmed reading.",
    );
  }
  return lines;
}
