import { addDay, localDay, tokenCount, type HistoryScan } from "../../history/history";
import { forEachTranscriptLine } from "../../history/transcripts";
import { isRecord, validDate } from "../../validation";
import { claudeSessionsPath } from "./claude";

/**
 * Claude transcripts record tokens, not account percentages, so the totals show relative activity
 * and are never presented as a share of a limit. Cache reads are excluded: they are about ten times
 * larger than the other counts and would make the total reflect context size.
 */

const MARKER = '"usage"';

/** Claude Code writes local notices, such as a limit being reached, under this model name. */
const SYNTHETIC_MODEL = "<synthetic>";

export interface ClaudeUsageRecord {
  at: number;
  /** Deduplication key; a resumed session replays earlier messages into its own transcript. */
  id: string;
  tokens: number;
}

/**
 * `message.id` identifies the message itself and repeats across transcripts; `uuid` identifies the
 * record and does not, so it can only stand in when no message id is present.
 */
function recordId(
  message: Record<string, unknown>,
  record: Record<string, unknown>,
): string | null {
  for (const candidate of [message.id, record.uuid]) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return null;
}

export function claudeUsage(line: string): ClaudeUsageRecord | null {
  if (!line.includes(MARKER)) {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record) || record.type !== "assistant" || !isRecord(record.message)) {
    return null;
  }
  const { message } = record;
  const usage = message.usage;
  if (message.model === SYNTHETIC_MODEL || !isRecord(usage)) {
    return null;
  }
  const at = validDate(record.timestamp);
  const id = recordId(message, record);
  if (!at || !id) {
    return null;
  }
  const tokens =
    tokenCount(usage.input_tokens) +
    tokenCount(usage.output_tokens) +
    tokenCount(usage.cache_creation_input_tokens);
  return tokens > 0 ? { at: at.getTime(), id, tokens } : null;
}

export async function scanClaudeHistory(since: number): Promise<HistoryScan> {
  const days: Record<string, number> = {};
  const seen = new Set<string>();
  await forEachTranscriptLine(claudeSessionsPath(), since, (line) => {
    const record = claudeUsage(line);
    if (!record || seen.has(record.id)) {
      return;
    }
    seen.add(record.id);
    addDay(days, localDay(new Date(record.at)), record.tokens);
  });
  return { days, last: null };
}
