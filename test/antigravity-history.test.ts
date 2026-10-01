import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { localDay } from "../src/history/history";
import {
  AntigravityHistory,
  isSettled,
  listConversations,
  tokensByDay,
  type Conversation,
} from "../src/providers/antigravity/antigravity-history";
import type { HubReply } from "../src/providers/antigravity/antigravity-hub";
import { realWritesOnly } from "../src/providers/antigravity/antigravity-watcher";

const MONDAY = "2026-09-28T12:00:00.000Z";
const TUESDAY = "2026-09-29T12:00:00.000Z";
const monday = localDay(new Date(MONDAY));
const tuesday = localDay(new Date(TUESDAY));

/** Shaped after a live `GetCascadeTrajectoryGeneratorMetadata` reply; counts arrive as strings. */
function call(stepIndices: number[], usage: Record<string, unknown>): unknown {
  return {
    stepIndices,
    chatModel: {
      model: "MODEL_PLACEHOLDER_M318",
      usage: {
        model: "MODEL_PLACEHOLDER_M318",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        ...usage,
      },
      retryInfos: [{ usage }],
      responseModel: "gemini-3.8-flash",
    },
    executionId: "5d6c1a3e-0000-4000-8000-000000000000",
  };
}

/** Shaped after a live `GetCascadeTrajectorySteps` reply, which also carries the conversation. */
function step(createdAt: string | undefined, type = "CORTEX_STEP_TYPE_PLANNER_RESPONSE"): unknown {
  return {
    type,
    status: "CORTEX_STEP_STATUS_DONE",
    metadata: { createdAt, source: "CORTEX_STEP_SOURCE_MODEL" },
    plannerResponse: { response: "text that is never read" },
  };
}

const METADATA = {
  generatorMetadata: [
    call([1, 2], { inputTokens: "12513", outputTokens: "439", thinkingOutputTokens: "351" }),
    call([3], { inputTokens: "2859", outputTokens: "4665", cacheReadTokens: "142761" }),
    call([5, 4], { inputTokens: "100", outputTokens: "1" }),
  ],
};

const STEPS = {
  steps: [
    step(MONDAY, "CORTEX_STEP_TYPE_USER_INPUT"),
    step(MONDAY),
    step(MONDAY, "CORTEX_STEP_TYPE_RUN_COMMAND"),
    step(MONDAY),
    step(TUESDAY),
    step(TUESDAY, "CORTEX_STEP_TYPE_VIEW_FILE"),
  ],
};

test("each call's input and output tokens land on the day its first step was made", () => {
  expect(tokensByDay(METADATA, STEPS)).toEqual({
    [monday]: 12_513 + 439 + 2_859 + 4_665,
    [tuesday]: 101,
  });
});

test("a call that cannot be dated or counted is left out rather than guessed at", () => {
  const metadata = {
    generatorMetadata: [
      call([9], { inputTokens: "500", outputTokens: "5" }),
      call([], { inputTokens: "500", outputTokens: "5" }),
      call([1], { inputTokens: "-4", outputTokens: "many" }),
      call([0], { inputTokens: "7", outputTokens: "3" }),
      { stepIndices: [1] },
      null,
    ],
  };
  const steps = { steps: [step(MONDAY), step(undefined)] };

  expect(tokensByDay(metadata, steps)).toEqual({ [monday]: 10 });
  expect(tokensByDay(null, null)).toEqual({});
  expect(tokensByDay({ generatorMetadata: "none" }, { steps: 4 })).toEqual({});
});

test("one absurd count cannot flatten every other day", () => {
  const metadata = {
    generatorMetadata: [call([0], { inputTokens: "900000000000", outputTokens: "1" })],
  };

  expect(tokensByDay(metadata, { steps: [step(MONDAY)] })).toEqual({ [monday]: 5_000_001 });
});

const NOW = Date.parse("2026-10-01T18:00:00.000Z");
const MINUTE = 60_000;

function conversation(databaseAgo: number, logAgo: number | null): Conversation {
  return {
    id: "9a88c19f-cfbf-4de2-819a-c18b22f1dea3",
    database: { mtimeMs: NOW - databaseAgo, size: 4096 },
    log: logAgo === null ? null : { mtimeMs: NOW - logAgo, size: 12_392 },
  };
}

test("a conversation is read only once it is quiet and its log holds nothing unsaved", () => {
  // Written a moment ago.
  expect(isSettled(conversation(10 * MINUTE, 5_000), NOW)).toBe(false);
  // Quiet, but the log is newer than the database: opening it would rewrite the database.
  expect(isSettled(conversation(10 * MINUTE, 5 * MINUTE), NOW)).toBe(false);
  // Saved by Antigravity itself half a minute after the last write, and quiet since.
  expect(isSettled(conversation(2 * MINUTE, 2.5 * MINUTE), NOW)).toBe(true);
  expect(isSettled(conversation(2 * MINUTE, null), NOW)).toBe(true);
  // Saved, but not quiet for a minute yet.
  expect(isSettled(conversation(30_000, 45_000), NOW)).toBe(false);
});

test("a log nobody has written for half an hour does not hold a conversation back for good", () => {
  expect(isSettled(conversation(3 * 60 * MINUTE, 29 * MINUTE), NOW)).toBe(false);
  expect(isSettled(conversation(3 * 60 * MINUTE, 31 * MINUTE), NOW)).toBe(true);
});

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-conversations-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const FIRST = "6e8dc499-9ba2-4284-b53f-7f2fb1523521";
const SECOND = "76c381b9-601c-4348-92d2-a0de47c57098";

async function write(name: string, content: string, ago: number): Promise<void> {
  const file = path.join(directory, name);
  await fs.writeFile(file, content, "utf8");
  const at = new Date(NOW - ago);
  await fs.utimes(file, at, at);
}

test("conversations are found by their database, and an empty log says nothing", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  await write(`${FIRST}.db-wal`, "", MINUTE);
  await write(`${FIRST}.db-shm`, "index", MINUTE);
  await write(`${SECOND}.db`, "database", 5 * 24 * 60 * MINUTE);
  await write(`${SECOND}.db-wal`, "unsaved", 2 * MINUTE);
  await write("not-a-conversation.db", "database", MINUTE);
  await write("conversation_summaries.db", "database", MINUTE);

  const found = await listConversations(directory, NOW - 24 * 60 * MINUTE);

  expect(found.map(({ id, log }) => ({ id, log: log?.size ?? null }))).toEqual([
    { id: FIRST, log: null },
    // In the span only because its log was written, though the database is days old.
    { id: SECOND, log: 7 },
  ]);
  expect(await listConversations(directory, NOW)).toEqual([]);
  expect(await listConversations(path.join(directory, "missing"), 0)).toEqual([]);
});

function harness(answers: Record<string, { metadata: HubReply; steps: HubReply }>) {
  const asked: string[] = [];
  let starts = 0;
  let failing = false;
  const history = new AntigravityHistory(
    (use) => {
      starts += 1;
      return use((method, body) => {
        const id = String(body?.cascadeId);
        asked.push(`${method}:${id.slice(0, 8)}`);
        if (failing) {
          return Promise.reject(new Error("connect ECONNREFUSED"));
        }
        const answer = answers[id];
        const empty = { status: 404, body: null };
        return Promise.resolve(
          method === "GetCascadeTrajectorySteps"
            ? (answer?.steps ?? empty)
            : (answer?.metadata ?? empty),
        );
      });
    },
    directory,
    () => NOW,
  );
  return {
    history,
    asked,
    starts: (): number => starts,
    fail: (): void => void (failing = true),
  };
}

const ok = (body: unknown): HubReply => ({ status: 200, body });
const ANSWERS = {
  [FIRST]: { metadata: ok(METADATA), steps: ok(STEPS) },
  [SECOND]: {
    metadata: ok({ generatorMetadata: [call([0], { inputTokens: "40", outputTokens: "2" })] }),
    steps: ok({ steps: [step(TUESDAY)] }),
  },
};

test("settled conversations are asked for once and remembered until their database changes", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  await write(`${SECOND}.db`, "database", 2 * 60 * MINUTE);
  const world = harness(ANSWERS);

  const first = await world.history.scan(0);

  expect(first).toEqual({
    days: { [monday]: 20_476, [tuesday]: 101 + 42 },
    last: null,
    pending: false,
  });
  expect(world.asked).toEqual([
    `GetCascadeTrajectoryGeneratorMetadata:${FIRST.slice(0, 8)}`,
    `GetCascadeTrajectorySteps:${FIRST.slice(0, 8)}`,
    `GetCascadeTrajectoryGeneratorMetadata:${SECOND.slice(0, 8)}`,
    `GetCascadeTrajectorySteps:${SECOND.slice(0, 8)}`,
  ]);

  await expect(world.history.scan(0)).resolves.toEqual(first);
  expect(world.starts()).toBe(1);

  await write(`${SECOND}.db`, "database, grown", 90 * MINUTE);
  await world.history.scan(0);

  expect(world.starts()).toBe(2);
  expect(world.asked.slice(4)).toEqual([
    `GetCascadeTrajectoryGeneratorMetadata:${SECOND.slice(0, 8)}`,
    `GetCascadeTrajectorySteps:${SECOND.slice(0, 8)}`,
  ]);
});

test("a conversation in use is not opened, and still counts with what it held before", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  const world = harness(ANSWERS);
  await world.history.scan(0);

  await write(`${FIRST}.db-wal`, "unsaved", 20_000);
  const during = await world.history.scan(0);

  expect(during).toEqual({ days: { [monday]: 20_476, [tuesday]: 101 }, last: null, pending: true });
  expect(world.starts()).toBe(1);
});

test("a conversation in use that was never read counts for nothing yet and starts no hub", async () => {
  await write(`${FIRST}.db`, "database", 20_000);
  const world = harness(ANSWERS);

  await expect(world.history.scan(0)).resolves.toEqual({ days: {}, last: null, pending: true });
  expect(world.starts()).toBe(0);
});

test("a conversation the hub will not hand over is not asked for again until it changes", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  const world = harness({
    [FIRST]: { metadata: { status: 500, body: { code: "internal" } }, steps: ok(STEPS) },
  });

  await expect(world.history.scan(0)).resolves.toEqual({ days: {}, last: null, pending: false });
  await world.history.scan(0);

  expect(world.starts()).toBe(1);
});

test("a hub that stops answering fails the scan and keeps what was already read", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  const world = harness(ANSWERS);
  await world.history.scan(0);

  await write(`${SECOND}.db`, "database", 2 * 60 * MINUTE);
  world.fail();

  await expect(world.history.scan(0)).rejects.toThrow("ECONNREFUSED");
});

test("a conversation that has left the scanned span is forgotten", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  const world = harness(ANSWERS);
  await world.history.scan(0);

  await expect(world.history.scan(NOW - MINUTE)).resolves.toEqual({
    days: {},
    last: null,
    pending: false,
  });
  await world.history.scan(0);

  expect(world.starts()).toBe(2);
});

function watched() {
  let fire: (() => void) | null = null;
  let clock = NOW;
  let changes = 0;
  const watcher = realWritesOnly(
    {
      start: (onChange) => void (fire = onChange),
      stop: () => void (fire = null),
      dispose: () => void (fire = null),
    },
    directory,
    () => clock,
  );
  watcher.start(() => void (changes += 1));
  return {
    watcher,
    changes: (): number => changes,
    /** The underlying watcher reports a change this long after the one before. */
    fires: async (afterMs: number): Promise<void> => {
      clock += afterMs;
      fire?.();
      // The check reads the directory, so it settles a few turns of the event loop later.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    watching: (): boolean => fire !== null,
  };
}

test("a change counts only when a conversation was really written", async () => {
  const world = watched();

  // A history scan leaves an empty log and an index beside a database it did not touch.
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  await write(`${FIRST}.db-wal`, "", -5_000);
  await write(`${FIRST}.db-shm`, "index", -5_000);
  await world.fires(6_000);
  expect(world.changes()).toBe(0);

  // A conversation in use writes to its log.
  await write(`${FIRST}.db-wal`, "unsaved", -10_000);
  await world.fires(6_000);
  expect(world.changes()).toBe(1);

  // The same state reported again is not a new write.
  await world.fires(6_000);
  expect(world.changes()).toBe(1);

  // Antigravity saving the conversation is one.
  await write(`${FIRST}.db`, "database, saved", -20_000);
  await world.fires(6_000);
  expect(world.changes()).toBe(2);
});

test("stopping the wrapper stops the watcher it wraps", () => {
  const world = watched();
  expect(world.watching()).toBe(true);

  world.watcher.stop();

  expect(world.watching()).toBe(false);
});

test("a window that has read nothing starts no hub when nothing was written since the last scan", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  const world = harness(ANSWERS);

  // The last scan, in whichever window, began an hour ago; the conversation is two hours older.
  await expect(world.history.scan(0, NOW - 60 * MINUTE)).resolves.toEqual({
    days: {},
    last: null,
    unchanged: true,
  });
  expect(world.starts()).toBe(0);
});

test("a conversation written shortly before the last scan is still looked for", async () => {
  // In use when that scan ran, so it was left unread; it has been saved since.
  await write(`${FIRST}.db`, "database", 80 * MINUTE);
  const world = harness(ANSWERS);

  const scan = await world.history.scan(0, NOW - 60 * MINUTE);

  expect(scan.unchanged).toBeUndefined();
  expect(scan.days).toEqual({ [monday]: 20_476, [tuesday]: 101 });
  expect(world.starts()).toBe(1);
});

test("a window that has already read is not told nothing changed", async () => {
  await write(`${FIRST}.db`, "database", 3 * 60 * MINUTE);
  const world = harness(ANSWERS);
  await world.history.scan(0);

  const scan = await world.history.scan(0, NOW - 60 * MINUTE);

  expect(scan.unchanged).toBeUndefined();
  expect(scan.days).toEqual({ [monday]: 20_476, [tuesday]: 101 });
  expect(world.starts()).toBe(1);
});
