import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodexAppServer, type CodexProcess } from "../src/codex-appserver";
import { isRecord } from "../src/usage";

/**
 * A controllable process covers framing, timeouts, and teardown races that a real Codex install
 * cannot reproduce deterministically.
 */

const RATE_LIMITS = {
  rateLimits: {
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1786215418 },
    secondary: null,
    planType: "plus",
  },
};

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

  says(...chunks: string[]): void {
    for (const chunk of chunks) {
      this.data?.(chunk);
    }
  }

  fires(event: "error" | "exit"): void {
    this.listeners.get(event)?.();
  }

  get requests(): Record<string, unknown>[] {
    return this.written
      .map((line) => JSON.parse(line) as unknown)
      .filter((message) => isRecord(message));
  }

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
    hold: (): void => void (holdNext = true),
    release: (child: CodexProcess): void => finishHeld?.(child),
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

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

  await expect(reading).resolves.toEqual({
    status: "unavailable",
    message: "Not signed in",
    verbatim: true,
  });
});

test("an error of this extension's own making is not marked as the server's", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

  codex.says(`${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "   " } })}\n`);

  await expect(reading).resolves.toEqual({
    status: "unavailable",
    message: "The Codex app server returned an error.",
    verbatim: false,
  });
});

test("a server that stops answering is dropped, and the next read starts a fresh one", async () => {
  const world = harness();
  const reading = world.app.readUsage();
  const codex = world.latest();
  await handshake(codex);

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
