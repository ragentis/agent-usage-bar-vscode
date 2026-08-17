import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FileWatcher } from "../src/watcher";

/**
 * These tests use the real platform watcher; the CI matrix covers inotify, FSEvents, and
 * ReadDirectoryChangesW behavior.
 */

const DEBOUNCE_MS = 50;
const RETRY_MS = 25;
const QUIET_MS = 600;
/** Deadline covering backend startup differences and watcher retry backoff. */
const DELIVERY_MS = 5_000;

let root = "";
const opened: FileWatcher[] = [];

beforeEach(async () => {
  // Canonicalize Windows 8.3 and macOS `/var` aliases before libuv compares event and root paths.
  // The promise API expands short names where the sync and callback forms do not.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-watch-")));
});

afterEach(async () => {
  for (const watcher of opened.splice(0)) {
    watcher.dispose();
  }
  await fs.rm(root, { recursive: true, force: true });
});

function watching(directory: string, onChange: () => void): FileWatcher {
  const watcher = new FileWatcher(
    { directory, fileSuffix: ".jsonl", recursive: true },
    DEBOUNCE_MS,
    RETRY_MS,
  );
  opened.push(watcher);
  watcher.start(onChange);
  return watcher;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delivered(seen: () => void, interval = 10): Promise<void> {
  return vi.waitFor(seen, { timeout: DELIVERY_MS, interval });
}

test("a burst inside a nested directory is one report, and other files are none", async () => {
  const session = path.join(root, "project", "nested");
  await fs.mkdir(session, { recursive: true });
  let changes = 0;
  watching(root, () => void (changes += 1));

  writeFileSync(path.join(session, "notes.txt"), "x", "utf8");
  await sleep(QUIET_MS);
  expect(changes).toBe(0);

  writeFileSync(path.join(session, "session.jsonl"), "{}", "utf8");
  writeFileSync(path.join(session, "session.jsonl"), '{"a":1}', "utf8");
  await delivered(() => expect(changes).toBe(1));

  await sleep(QUIET_MS);
  expect(changes).toBe(1);
});

test("stopping ends the reports", async () => {
  await fs.mkdir(path.join(root, "project"), { recursive: true });
  let changes = 0;
  const watcher = watching(root, () => void (changes += 1));

  writeFileSync(path.join(root, "project", "a.jsonl"), "{}", "utf8");
  await delivered(() => expect(changes).toBe(1));

  watcher.stop();
  writeFileSync(path.join(root, "project", "a.jsonl"), '{"a":2}', "utf8");
  await sleep(QUIET_MS);

  expect(changes).toBe(1);
});

test("a directory that does not exist yet is picked up once the agent creates it", async () => {
  const late = path.join(root, "not-yet");
  let changes = 0;
  watching(late, () => void (changes += 1));

  await sleep(QUIET_MS);
  expect(changes).toBe(0);

  await fs.mkdir(late, { recursive: true });
  await delivered(() => {
    writeFileSync(path.join(late, "session.jsonl"), String(Date.now()), "utf8");
    expect(changes).toBeGreaterThan(0);
    // Write slower than debounce so polling cannot continuously postpone the report it awaits.
  }, DEBOUNCE_MS * 2);
});
