import { createReadStream, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Provider transcripts are read for their recorded numbers only. Nothing from a message body is
 * parsed, kept, or shown; both providers hand their line handler the raw text and take a sample or
 * a token count out of it.
 */

/**
 * Directory depth is bounded because a transcript tree is shallow by construction, and the file
 * count because a scan runs on a filesystem event.
 */
const MAX_DEPTH = 8;
const MAX_FILES = 20_000;

async function directories(root: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // A directory that cannot be listed is not an error worth surfacing; history is best effort.
    return;
  }
  const nested: Promise<void>[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      nested.push(directories(entryPath, depth + 1, found));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(entryPath);
    }
  }
  await Promise.all(nested);
}

/**
 * Modification time is the only sound filter. A resumed session appends to the file it started in,
 * so neither the file name nor Codex's date-partitioned folders say which days a file now holds,
 * while a file containing a day's records cannot have been written before that day.
 */
async function changedSince(files: readonly string[], since: number): Promise<string[]> {
  const modified = await Promise.all(
    files.map((file) =>
      fs.stat(file).then(
        (stats) => stats.mtimeMs,
        // A file that went away between listing and checking is simply not part of this scan.
        () => 0,
      ),
    ),
  );
  return files.filter((_, index) => (modified[index] ?? 0) >= since);
}

/**
 * Streamed because one long session's transcript reaches tens of megabytes, and the session being
 * written is read again by every scan. `readline` is not used: it also breaks lines at `\r` and
 * U+2028, which are valid inside a JSON string.
 */
async function forEachLine(file: string, onLine: (line: string) => void): Promise<void> {
  let rest = "";
  for await (const chunk of createReadStream(file, "utf8") as AsyncIterable<string>) {
    const end = chunk.lastIndexOf("\n");
    if (end === -1) {
      rest += chunk;
      continue;
    }
    for (const line of (rest + chunk.slice(0, end)).split("\n")) {
      if (line) {
        onLine(line);
      }
    }
    rest = chunk.slice(end + 1);
  }
  if (rest) {
    onLine(rest);
  }
}

export async function forEachTranscriptLine(
  root: string,
  since: number,
  onLine: (line: string) => void,
): Promise<void> {
  const found: string[] = [];
  await directories(root, 0, found);
  for (const file of await changedSince(found, since)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- reading the tree in parallel would hold a stream open per session
      await forEachLine(file, onLine);
    } catch {
      // Session files are rewritten and removed while this runs; skip whatever went away.
    }
  }
}
