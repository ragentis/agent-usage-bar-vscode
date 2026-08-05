import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FileWatcher } from "../src/watcher";

/**
 * The one test in this project that runs against the real thing, because a file watcher is the
 * platform. `recursive` in particular is a different implementation on each of the three — inotify,
 * FSEvents, ReadDirectoryChangesW — so it is watched here the way the extension watches, and the
 * CI matrix is what turns that into an answer for all three.
 */

const DEBOUNCE_MS = 50;
const RETRY_MS = 25;
/** Long enough that nothing reported is nothing reported, rather than something not reported yet. */
const QUIET_MS = 600;
/**
 * A ceiling, not a wait: a report normally lands one debounce after the write, and this is only
 * ever spent in full when none comes at all. Generous because the three backends differ by an order
 * of magnitude in how quickly they deliver the first one, and because the watcher's own retry
 * doubles its way up to a directory that was not there when it started looking.
 */
const DELIVERY_MS = 5_000;

let root = "";
const opened: FileWatcher[] = [];

beforeEach(async () => {
  // Canonical, not merely temporary. libuv asserts that the absolute path an event carries begins
  // with the directory it was handed, and a temporary root reaches it under a name that fails that
  // test on two of the three platforms: the Windows runner's TEMP is an 8.3 short path, and macOS
  // hands out `/var/folders` for a `/private/var` that FSEvents reports in full. On Windows the
  // assertion aborts the process, so it arrives as a dead worker rather than a failing test.
  // The promises `realpath` is the one that expands a short name; the sync and callback forms
  // resolve symlinks only and would leave `RUNNER~1` exactly as they found it.
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

/** Retries until the report has landed, so a slow backend costs time rather than an answer. */
function delivered(seen: () => void, interval = 10): Promise<void> {
  return vi.waitFor(seen, { timeout: DELIVERY_MS, interval });
}

test("a burst inside a nested directory is one report, and other files are none", async () => {
  // The shape the agents actually write: a session transcript, a project directory deep.
  const session = path.join(root, "project", "nested");
  await fs.mkdir(session, { recursive: true });
  let changes = 0;
  watching(root, () => void (changes += 1));

  writeFileSync(path.join(session, "notes.txt"), "x", "utf8");
  await sleep(QUIET_MS);
  expect(changes).toBe(0);

  // Written synchronously so the burst cannot straddle the debounce window.
  writeFileSync(path.join(session, "session.jsonl"), "{}", "utf8");
  writeFileSync(path.join(session, "session.jsonl"), '{"a":1}', "utf8");
  await delivered(() => expect(changes).toBe(1));

  // One report, not the first of several: an undebounced second would arrive a debounce behind the
  // one just seen, so the count is worth nothing until a stretch longer than that has passed.
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
  // `~/.claude/projects` and `~/.codex/sessions` are not there until that agent has run once, which
  // is the ordinary case on a fresh machine rather than an error worth reporting.
  const late = path.join(root, "not-yet");
  let changes = 0;
  watching(late, () => void (changes += 1));

  await sleep(QUIET_MS);
  expect(changes).toBe(0);

  await fs.mkdir(late, { recursive: true });
  await delivered(() => {
    // Written on every attempt because the retry that finds the directory and the write that it
    // would report are on separate clocks; what is under test is that a retry comes at all.
    writeFileSync(path.join(late, "session.jsonl"), String(Date.now()), "utf8");
    expect(changes).toBeGreaterThan(0);
    // Slower than the debounce, or the writing starves the thing it is waiting for: every write
    // restarts the timer, and a backend that delivers in under a millisecond would restart it just
    // before each expiry, forever. Expressed against the debounce so the two cannot drift apart.
  }, DEBOUNCE_MS * 2);
});
