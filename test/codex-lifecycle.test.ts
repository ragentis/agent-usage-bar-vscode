import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodexAppServer, type CodexProcess } from "../src/codex-appserver";
import { isRecord } from "../src/usage";

/**
 * The parsing of a reply lives beside the response shape in `codex-appserver.test.ts`. What is here
 * is the half a reply never reaches: framing, a server that stops answering, a teardown landing on
 * a request already in flight. None of it can be provoked through a real Codex install, so the
 * process is stood up here instead — the class takes its launch as a seam for exactly this reason.
 */

const RATE_LIMITS = {
  rateLimits: {
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1786215418 },
    secondary: null,
    planType: "plus",
  },
};

/** A `codex app-server` that says only what the test tells it to, when the test tells it to. */
class FakeCodex implements CodexProcess {
  readonly written: string[] = [];
  killed = 0;
  drainedStderr = false;
  encoding: string | null = null;
  writeError: Error | null = null;
  private data: ((chunk: string) => void) | null = null;
  private readonly listeners = new Map<string, () => void>();

  readonly stdin = {
    write: (chunk: string, callback?: (error?: Error | null) => void): void => {
      this.written.push(chunk);
      callback?.(this.writeError);
    },
  };

  readonly stdout = {
    setEncoding: (encoding: "utf8"): void => void (this.encoding = encoding),
    on: (_event: "data", listener: (chunk: string) => void): void => void (this.data = listener),
  };

  readonly stderr = { resume: (): void => void (this.drainedStderr = true) };

  on(event: "error" | "exit", listener: () => void): void {
    this.listeners.set(event, listener);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  kill(): void {
    this.killed += 1;
  }

  /** What the process writes to stdout, arriving exactly as the test hands it over. */
  says(...chunks: string[]): void {
    for (const chunk of chunks) {
      this.data?.(chunk);
    }
  }

  fires(event: "error" | "exit"): void {
    this.listeners.get(event)?.();
  }

  /** Every request it has been sent, in order. */
  get requests(): Record<string, unknown>[] {
    return this.written
      .map((line) => JSON.parse(line) as unknown)
      .filter((message) => isRecord(message));
  }

  /** Answers whatever it was asked last; `splitAt` delivers that answer in two chunks. */
  answers(result: unknown, splitAt?: number): void {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: this.requests.at(-1)?.id, result })}\n`;
    this.says(
      ...(splitAt === undefined ? [frame] : [frame.slice(0, splitAt), frame.slice(splitAt)]),
    );
  }
}

function harness(onPush: () => void = () => {}) {
  const spawned: FakeCodex[] = [];
  let launches = 0;
  let holdNext = false;
  let finishHeld: ((child: CodexProcess) => void) | null = null;
  const app = new CodexAppServer(onPush, () => {
    launches += 1;
    if (holdNext) {
      holdNext = false;
      return new Promise<CodexProcess>((resolve) => {
        finishHeld = resolve;
      });
    }
    const child = new FakeCodex();
    spawned.push(child);
    return Promise.resolve(child);
  });
  return {
    app,
    spawned,
    latest: (): FakeCodex => {
      const child = spawned.at(-1);
      if (!child) {
        throw new Error("nothing was launched");
      }
      return child;
    },
    attempts: (): number => launches,
    /** Makes the next launch hang, so a stop can land in the middle of one. */
    hold: (): void => void (holdNext = true),
    release: (child: CodexProcess): void => finishHeld?.(child),
  };
}

/** Lets whatever is queued run, without letting any timer come due. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Carries the handshake as far as the read request, which is where each test takes over. */
async function handshake(codex: FakeCodex): Promise<void> {
  await flush();
  codex.answers({});
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a reply split across two chunks is read as the one message it is", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  expect(codex.encoding).toBe("utf8");
  expect(codex.drainedStderr).toBe(true);
  expect(codex.requests.map((request) => request.method)).toEqual([
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);

  // A pipe splits where it likes, and JSON-RPC frames carry no length: only the newline says where
  // a message ends. Split mid-number, which is where a naive reader would parse half a reading.
  codex.answers(RATE_LIMITS, 40);

  await expect(reading).resolves.toMatchObject({ status: "ok" });
});

test("two messages arriving in one chunk are both read", async () => {
  const pushes: number[] = [];
  const world = harness(() => void pushes.push(1));
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  const push = JSON.stringify({ jsonrpc: "2.0", method: "account/rateLimits/updated" });
  const answer = JSON.stringify({ jsonrpc: "2.0", id: 2, result: RATE_LIMITS });
  codex.says(`${push}\n${answer}\n`);

  await expect(reading).resolves.toMatchObject({ status: "ok" });
  expect(pushes).toHaveLength(1);
});

test("an error the server names is what the item says", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  codex.says(`${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "Not signed in" } })}\n`);

  await expect(reading).resolves.toEqual({ status: "unavailable", message: "Not signed in" });
});

test("a server that stops answering is dropped, and the next read starts a fresh one", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  // Never answered. Dropping only the request would leave every later read queued behind the same
  // silent process for as long as the window stayed open.
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(reading).resolves.toMatchObject({ status: "unavailable" });
  expect(codex.killed).toBe(1);

  const second = world.app.readUsage();
  await handshake(world.latest());
  world.latest().answers(RATE_LIMITS);

  await expect(second).resolves.toMatchObject({ status: "ok" });
  expect(world.spawned).toHaveLength(2);
});

test("a process that exits mid-request answers it rather than leaving it hanging", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  codex.fires("exit");

  await expect(reading).resolves.toMatchObject({ status: "unavailable" });
});

test("a stream that never breaks into messages is dropped rather than held", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  // No newline, so nothing can ever be parsed out of it: the buffer is all that would grow.
  codex.says("x".repeat(5 * 1024 * 1024));

  await expect(reading).resolves.toMatchObject({ status: "unavailable" });
  expect(codex.killed).toBe(1);
});

test("a provider stopped part way through starting leaves nothing running behind it", async () => {
  const world = harness();
  world.hold();
  const reading = world.app.readUsage();
  await flush();

  world.app.stop();
  const orphan = new FakeCodex();
  world.release(orphan);

  await expect(reading).resolves.toMatchObject({ status: "unavailable" });
  // Started after the only thing that would have owned it gave up: nothing else would ever stop it.
  expect(orphan.killed).toBe(1);
});

test("being stopped is not failing to start, and does not cost the respawn cooldown", async () => {
  const world = harness();
  world.hold();
  const reading = world.app.readUsage();
  await flush();
  world.app.stop();
  world.release(new FakeCodex());
  await reading;

  // Switching the provider back on has to answer at once; the cooldown is for a machine that
  // cannot start Codex, not for one that was told to stop.
  const second = world.app.readUsage();
  await handshake(world.latest());
  world.latest().answers(RATE_LIMITS);

  await expect(second).resolves.toMatchObject({ status: "ok" });
  expect(world.attempts()).toBe(2);
});

test("a machine with no Codex is not asked again on every read", async () => {
  let attempts = 0;
  const app = new CodexAppServer(
    () => {},
    () => {
      attempts += 1;
      return Promise.reject(new Error("spawn ENOENT"));
    },
  );

  await expect(app.readUsage()).resolves.toMatchObject({ status: "unavailable" });
  await expect(app.readUsage()).resolves.toMatchObject({ status: "unavailable" });
  expect(attempts).toBe(1);

  // The cooldown is a pause, not a verdict: an install that lands later is picked up.
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(app.readUsage()).resolves.toMatchObject({ status: "unavailable" });
  expect(attempts).toBe(2);
});

test("a disposed server rules out every later read", async () => {
  const world = harness();
  world.app.dispose();

  await expect(world.app.readUsage()).resolves.toMatchObject({ status: "unavailable" });
  expect(world.attempts()).toBe(0);
});
