import { codexSessionsPath } from "./codex";
import { scanFromSamples, type HistoryScan, type UsageSample } from "./history";
import { forEachTranscriptLine } from "./transcripts";
import { classifyWindow, isRecord, validDate, validUsedPercent, validWindowMinutes } from "./usage";

/**
 * Codex records the account's own rate-limit percentages beside every token count, so a day's spend
 * is reconstructed in the same unit the status bar shows rather than estimated from tokens.
 */

const MARKER = "rate_limits";

/**
 * Codex has moved the weekly window between `primary` and `secondary` across versions. Selecting it
 * by duration applies the same rule as a live reading and keeps older transcripts readable.
 */
function weeklyPercent(limits: Record<string, unknown>): number | null {
  for (const key of ["primary", "secondary"]) {
    const window = limits[key];
    if (!isRecord(window)) {
      continue;
    }
    const minutes = validWindowMinutes(window.window_minutes);
    if (minutes === null || classifyWindow(minutes, "session") !== "weekly") {
      continue;
    }
    const usedPercent = validUsedPercent(window.used_percent);
    if (usedPercent !== null) {
      return usedPercent;
    }
  }
  return null;
}

export function codexSample(line: string): UsageSample | null {
  // Most transcript lines are message content; the substring test keeps them out of the parser.
  if (!line.includes(MARKER)) {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record) || !isRecord(record.payload)) {
    return null;
  }
  const at = validDate(record.timestamp);
  const limits = record.payload.rate_limits;
  if (!at || !isRecord(limits)) {
    return null;
  }
  const usedPercent = weeklyPercent(limits);
  return usedPercent === null ? null : { at: at.getTime(), usedPercent };
}

export async function scanCodexHistory(
  since: number,
  seed: UsageSample | null,
): Promise<HistoryScan> {
  const samples: UsageSample[] = [];
  await forEachTranscriptLine(codexSessionsPath(), since, (line) => {
    const sample = codexSample(line);
    if (sample) {
      samples.push(sample);
    }
  });
  return scanFromSamples(samples, seed);
}
