import * as fs from "node:fs/promises";
import * as path from "node:path";
import { antigravityConversationsPath } from "./antigravity";
import type { Hub } from "./antigravity-hub";
import { addDay, localDay, tokenCount, type HistoryScan } from "./history";
import type { ProviderWatcher } from "./usage-bar";
import { isRecord, validDate } from "./usage";

/**
 * Each Antigravity conversation is a database that only its hub can read. Two hub calls are made
 * per conversation: one returns the tokens of every model call, the other the steps, whose times
 * date those calls. The steps reply also contains the conversation content; only step times are
 * read. Cache reads are excluded, as for Claude Code.
 */

const DATABASE_SUFFIX = ".db";
const LOG_SUFFIX = ".db-wal";

/** The id is sent in a request, so file names that are not ids are skipped. */
const CONVERSATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * Opening a conversation that still has changes in its write-ahead log makes SQLite move them into
 * the database, which changes a file Antigravity is working on. So a conversation is read only once
 * it has been quiet for a minute and its log holds nothing newer than the database.
 */
const QUIET_MS = 60_000;

/** A log not written for this long is treated as left over; the conversation is not in use. */
const ABANDONED_MS = 30 * 60_000;

interface FileState {
  mtimeMs: number;
  size: number;
}

export interface Conversation {
  id: string;
  database: FileState;
  /** The write-ahead log, when it exists and holds anything. */
  log: FileState | null;
}

async function fileState(file: string): Promise<FileState | null> {
  try {
    const stats = await fs.stat(file);
    return stats.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : null;
  } catch {
    return null;
  }
}

/** Conversations written since `since`. An empty log left by a read does not count as a write. */
export async function listConversations(directory: string, since: number): Promise<Conversation[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith(DATABASE_SUFFIX))
    .map((name) => name.slice(0, -DATABASE_SUFFIX.length))
    .filter((id) => CONVERSATION_ID.test(id))
    // Directory order differs between filesystems; a fixed one keeps scans repeatable.
    .toSorted();
  const found = await Promise.all(
    ids.map(async (id): Promise<Conversation | null> => {
      const [database, log] = await Promise.all([
        fileState(path.join(directory, `${id}${DATABASE_SUFFIX}`)),
        fileState(path.join(directory, `${id}${LOG_SUFFIX}`)),
      ]);
      return database ? { id, database, log: log && log.size > 0 ? log : null } : null;
    }),
  );
  return found
    .filter((conversation) => conversation !== null)
    .filter(({ database, log }) => Math.max(database.mtimeMs, log?.mtimeMs ?? 0) >= since);
}

export function isSettled({ database, log }: Conversation, now: number): boolean {
  const idle = now - Math.max(database.mtimeMs, log?.mtimeMs ?? 0);
  if (idle >= ABANDONED_MS) {
    return true;
  }
  return idle >= QUIET_MS && (log === null || log.mtimeMs <= database.mtimeMs);
}

/** The hub writes 64-bit counts as strings. */
function count(value: unknown): number {
  return tokenCount(typeof value === "string" ? Number(value) : value);
}

function firstStep(indices: unknown): number | null {
  if (!Array.isArray(indices)) {
    return null;
  }
  const valid = indices.filter(
    (index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0,
  );
  return valid.length === 0 ? null : Math.min(...valid);
}

function stepTime(step: unknown): Date | null {
  const metadata = isRecord(step) ? step.metadata : null;
  // A bare number would be read as seconds; the hub writes these times as text.
  return isRecord(metadata) && typeof metadata.createdAt === "string"
    ? validDate(metadata.createdAt)
    : null;
}

/** A call without a dated step is skipped instead of being assigned a guessed day. */
export function tokensByDay(metadata: unknown, steps: unknown): Record<string, number> {
  const calls =
    isRecord(metadata) && Array.isArray(metadata.generatorMetadata)
      ? metadata.generatorMetadata
      : [];
  const list: unknown[] = isRecord(steps) && Array.isArray(steps.steps) ? steps.steps : [];
  const days: Record<string, number> = {};
  for (const call of calls) {
    const model = isRecord(call) ? call.chatModel : null;
    const usage = isRecord(model) ? model.usage : null;
    const index = isRecord(call) ? firstStep(call.stepIndices) : null;
    if (!isRecord(usage) || index === null) {
      continue;
    }
    const tokens = count(usage.inputTokens) + count(usage.outputTokens);
    const at = stepTime(list[index]);
    if (tokens > 0 && at) {
      addDay(days, localDay(at), tokens);
    }
  }
  return days;
}

/** File times and the clock are compared across a debounce, so a write is given this much slack. */
const WRITE_SLACK_MS = 1_000;

/**
 * Reading a conversation makes SQLite recreate its empty companion files, and the file watcher
 * reports that as a change. Reporting it would make every scan trigger another scan, so a change
 * counts only when a conversation was written since the previous change.
 */
export function realWritesOnly(
  watcher: ProviderWatcher,
  directory: string = antigravityConversationsPath(),
  now: () => number = Date.now,
): ProviderWatcher {
  return {
    start: (onChange) => {
      let seen = now();
      const report = async (since: number): Promise<void> => {
        if ((await listConversations(directory, since)).length > 0) {
          onChange();
        }
      };
      watcher.start(() => {
        const since = seen - WRITE_SLACK_MS;
        seen = now();
        void report(since);
      });
    },
    stop: () => watcher.stop(),
    dispose: () => watcher.dispose(),
  };
}

export type QueryHub = <T>(use: (call: Hub["call"]) => Promise<T>) => Promise<T>;

interface Known {
  /** The database as it was when read, so an unchanged conversation is not asked for again. */
  signature: string;
  days: Record<string, number>;
}

function signatureOf({ database }: Conversation): string {
  return `${database.mtimeMs}:${database.size}`;
}

/**
 * Per-conversation totals are kept between scans. A hub is then started only when a settled
 * conversation has changed, and a conversation that cannot be read now keeps its last known total.
 */
export class AntigravityHistory {
  private readonly known = new Map<string, Known>();

  constructor(
    private readonly query: QueryHub,
    private readonly directory: string = antigravityConversationsPath(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A window with no totals in memory would have to ask for every conversation in the span. It
   * skips that when no conversation was written since the last stored scan, because the stored days
   * are then complete. The check reaches `ABANDONED_MS` further back to include a conversation that
   * scan skipped as in use.
   */
  async scan(since: number, scannedAt = 0): Promise<HistoryScan> {
    if (this.known.size === 0 && scannedAt > 0) {
      const written = await listConversations(this.directory, scannedAt - ABANDONED_MS);
      if (written.length === 0) {
        return { days: {}, last: null, unchanged: true };
      }
    }
    const conversations = await listConversations(this.directory, since);
    const now = this.now();
    const unsettled = conversations.filter((conversation) => !isSettled(conversation, now));
    const changed = conversations.filter(
      (conversation) =>
        !unsettled.includes(conversation) &&
        this.known.get(conversation.id)?.signature !== signatureOf(conversation),
    );
    if (changed.length > 0) {
      await this.query(async (call) => {
        for (const conversation of changed) {
          const request = { cascadeId: conversation.id };
          // One conversation at a time keeps a single answer in memory.
          // oxlint-disable-next-line no-await-in-loop
          const metadata = await call("GetCascadeTrajectoryGeneratorMetadata", request);
          // oxlint-disable-next-line no-await-in-loop
          const steps = await call("GetCascadeTrajectorySteps", request);
          // A conversation the hub cannot return counts as zero until it changes.
          const readable = metadata.status === 200 && steps.status === 200;
          this.known.set(conversation.id, {
            signature: signatureOf(conversation),
            days: readable ? tokensByDay(metadata.body, steps.body) : {},
          });
        }
      });
    }
    const days: Record<string, number> = {};
    const inSpan = new Set(conversations.map((conversation) => conversation.id));
    for (const [id, known] of this.known) {
      if (!inSpan.has(id)) {
        this.known.delete(id);
        continue;
      }
      for (const [day, tokens] of Object.entries(known.days)) {
        addDay(days, day, tokens);
      }
    }
    return { days, last: null, pending: unsettled.length > 0 };
  }
}
