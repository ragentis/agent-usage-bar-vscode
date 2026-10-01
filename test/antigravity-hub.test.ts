import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { antigravityBinary } from "../src/antigravity";
import {
  AntigravityHub,
  parsePlan,
  parseQuotaSummary,
  type Hub,
  type HubProcess,
  type HubReply,
} from "../src/antigravity-hub";

const fetchedAt = new Date("2026-10-01T00:32:00.000Z");

/** Shaped after a live `RetrieveUserQuotaSummary` reply on a Pro plan. */
const SUMMARY = {
  response: {
    groups: [
      {
        displayName: "Gemini Models",
        description: "Models within this group: Gemini Flash, Gemini Pro",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            description: "You have used some of your weekly limit.",
            window: "weekly",
            remainingFraction: 0.75,
            resetTime: "2026-10-05T23:57:28Z",
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            remainingFraction: 1,
            resetTime: "2026-10-01T05:31:55Z",
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            remainingFraction: 0.5,
            resetTime: "2026-10-08T00:31:55Z",
          },
          {
            bucketId: "3p-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            remainingFraction: 0.9,
            resetTime: "2026-10-01T05:31:55Z",
          },
        ],
      },
    ],
    description: "Within each group, models share a weekly limit and a 5-hour limit.",
  },
};

/** The part of a live `GetUserStatus` reply that is read; the rest names the account holder. */
const USER_STATUS = {
  userStatus: {
    name: "Someone",
    email: "someone@example.com",
    planStatus: { planInfo: { teamsTier: "TEAMS_TIER_PRO", planName: "Pro" } },
  },
};

const SIGNED_IN = { authResult: { hasValidAuth: true, grantedScopes: ["email"] } };

function group(...buckets: unknown[]): unknown {
  return { response: { groups: [{ displayName: "Gemini Models", buckets }] } };
}

test("every bucket becomes a window named after its group, shortest first", () => {
  const snapshot = parseQuotaSummary(SUMMARY, fetchedAt);

  expect(
    snapshot?.windows.map(({ kind, label, usedPercent, windowMinutes }) => ({
      kind,
      label,
      usedPercent: Math.round(usedPercent),
      windowMinutes,
    })),
  ).toEqual([
    { kind: "session", label: "Claude and GPT", usedPercent: 10, windowMinutes: 300 },
    { kind: "session", label: "Gemini", usedPercent: 0, windowMinutes: 300 },
    { kind: "weekly", label: "Claude and GPT", usedPercent: 50, windowMinutes: 10_080 },
    { kind: "weekly", label: "Gemini", usedPercent: 25, windowMinutes: 10_080 },
  ]);
  expect(snapshot?.windows[3]?.resetsAt?.toISOString()).toBe("2026-10-05T23:57:28.000Z");
  expect(snapshot).toMatchObject({ source: "antigravity-hub", plan: null, blocked: null });
});

test("a spent bucket arrives without its fraction and still reads as full", () => {
  const snapshot = parseQuotaSummary(
    group({ window: "5h", resetTime: "2026-10-01T05:31:55Z" }),
    fetchedAt,
  );

  expect(snapshot?.windows).toMatchObject([{ kind: "session", usedPercent: 100 }]);
});

test("a bucket that cannot be understood is left out rather than guessed at", () => {
  const snapshot = parseQuotaSummary(
    group(
      { window: "5h" },
      { window: "monthly", remainingFraction: 0.5, resetTime: "2026-10-05T23:57:28Z" },
      { window: "weekly", remainingFraction: 1.5, resetTime: "2026-10-05T23:57:28Z" },
      { window: "constructor", remainingFraction: 0.5 },
      { window: "weekly", remainingFraction: 0.2 },
    ),
    fetchedAt,
  );

  expect(snapshot?.windows).toMatchObject([{ kind: "weekly", usedPercent: 80, resetsAt: null }]);
});

test("an answer with no usable bucket is no reading at all", () => {
  expect(parseQuotaSummary(null, fetchedAt)).toBeNull();
  expect(parseQuotaSummary({}, fetchedAt)).toBeNull();
  expect(parseQuotaSummary({ response: { groups: [] } }, fetchedAt)).toBeNull();
  expect(parseQuotaSummary(group({ window: "5h" }), fetchedAt)).toBeNull();
});

test("only the plan name is taken out of the account answer", () => {
  expect(parsePlan(USER_STATUS)).toBe("Pro");
  expect(parsePlan({ userStatus: { planStatus: {} } })).toBeNull();
  expect(parsePlan({ userStatus: { planStatus: { planInfo: { planName: 7 } } } })).toBeNull();
  expect(parsePlan(null)).toBeNull();
});

test("the CLI is looked for where Antigravity installs it", () => {
  expect(antigravityBinary("/home/me", "linux")).toBe(
    path.join("/home/me", ".gemini", "bin", "agy"),
  );
  expect(antigravityBinary("/home/me", "win32")).toBe(
    path.join("/home/me", ".gemini", "bin", "agy.exe"),
  );
});

/**
 * A controllable hub covers startup polling, teardown races, and a missing binary, none of which a
 * real install reproduces on demand.
 */

class FakeProcess implements HubProcess {
  killed = 0;
  private readonly listeners = new Map<string, (error?: unknown) => void>();

  on(event: "error" | "exit", listener: (error?: unknown) => void): void {
    this.listeners.set(event, listener);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  kill(): void {
    this.killed += 1;
  }

  fires(event: "error" | "exit", error?: unknown): void {
    this.listeners.get(event)?.(error);
  }
}

const REFUSED = new Error("connect ECONNREFUSED");
const NO_SUCH_PROGRAM = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });

type Answer = HubReply | Error;

function ok(body: unknown): HubReply {
  return { status: 200, body };
}

/** Answers every method the way a healthy, signed-in hub does unless a test says otherwise. */
function answering(overrides: Record<string, (attempt: number) => Answer> = {}) {
  return (method: string, attempt: number): Answer => {
    const override = overrides[method];
    if (override) {
      return override(attempt);
    }
    switch (method) {
      case "RetrieveUserQuotaSummary":
        return ok(SUMMARY);
      case "GetUserStatus":
        return ok(USER_STATUS);
      case "GetAuthStatus":
        return ok(SIGNED_IN);
      default:
        return { status: 404, body: null };
    }
  };
}

function harness(respond: (method: string, attempt: number) => Answer = answering()) {
  const processes: FakeProcess[] = [];
  const calls: string[] = [];
  let launches = 0;
  let holdNext = false;
  let finishHeld: ((hub: Hub) => void) | null = null;
  const build = (): Hub => {
    const process = new FakeProcess();
    processes.push(process);
    return {
      process,
      call: (method) => {
        calls.push(method);
        const answer = respond(method, calls.filter((called) => called === method).length);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    };
  };
  const hub = new AntigravityHub(() => {
    launches += 1;
    if (holdNext) {
      holdNext = false;
      return new Promise<Hub>((resolve) => {
        finishHeld = resolve;
      });
    }
    return Promise.resolve(build());
  });
  return {
    hub,
    processes,
    calls,
    latest: (): FakeProcess => {
      const process = processes.at(-1);
      if (!process) {
        throw new Error("nothing was launched");
      }
      return process;
    },
    attempts: (): number => launches,
    hold: (): void => void (holdNext = true),
    release: (): Hub => {
      const held = build();
      finishHeld?.(held);
      return held;
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a hub that is still starting is asked again until it answers, then stopped", async () => {
  const world = harness(
    answering({ RetrieveUserQuotaSummary: (attempt) => (attempt < 3 ? REFUSED : ok(SUMMARY)) }),
  );
  const reading = world.hub.readUsage();
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(reading).resolves.toMatchObject({
    status: "ok",
    snapshot: { plan: "Pro", source: "antigravity-hub" },
  });
  expect(world.calls).toEqual([
    "RetrieveUserQuotaSummary",
    "RetrieveUserQuotaSummary",
    "RetrieveUserQuotaSummary",
    "GetUserStatus",
  ]);
  expect(world.latest().killed).toBe(1);
});

test("every read starts a hub of its own", async () => {
  const world = harness();

  await expect(world.hub.readUsage()).resolves.toMatchObject({ status: "ok" });
  await expect(world.hub.readUsage()).resolves.toMatchObject({ status: "ok" });

  expect(world.processes.map((process) => process.killed)).toEqual([1, 1]);
});

test("a hub that never listens is given up on and stopped", async () => {
  const world = harness(answering({ RetrieveUserQuotaSummary: () => REFUSED }));
  const reading = world.hub.readUsage();
  await vi.advanceTimersByTimeAsync(60_000);

  await expect(reading).resolves.toEqual({
    status: "unavailable",
    message: "Antigravity did not answer in time.",
  });
  expect(world.latest().killed).toBe(1);
});

test("a plan that cannot be read does not cost the reading", async () => {
  const world = harness(answering({ GetUserStatus: () => REFUSED }));

  await expect(world.hub.readUsage()).resolves.toMatchObject({
    status: "ok",
    snapshot: { plan: null },
  });
});

test("an answer without windows from a signed-out hub asks for a sign-in", async () => {
  const world = harness(
    answering({
      RetrieveUserQuotaSummary: () => ({
        status: 401,
        body: { code: "unauthenticated", message: "You are not logged into Antigravity." },
      }),
      GetAuthStatus: () => ok({ authResult: {} }),
    }),
  );

  await expect(world.hub.readUsage()).resolves.toEqual({
    status: "unavailable",
    message: "Antigravity is not signed in. Sign in to the CLI or extension.",
  });
  expect(world.latest().killed).toBe(1);
});

test("an error a signed-in hub names is what the item says", async () => {
  const world = harness(
    answering({
      RetrieveUserQuotaSummary: () => ({
        status: 503,
        body: { code: "unavailable", message: "quota service unreachable" },
      }),
    }),
  );

  await expect(world.hub.readUsage()).resolves.toEqual({
    status: "unavailable",
    message: "quota service unreachable",
    verbatim: true,
  });
});

test("a signed-in hub with nothing to report says so in this extension's words", async () => {
  const world = harness(answering({ RetrieveUserQuotaSummary: () => ok({}) }));

  await expect(world.hub.readUsage()).resolves.toEqual({
    status: "unavailable",
    message: "Antigravity reported no usage windows.",
  });
});

test("a hub that exits before answering ends the read rather than leaving it waiting", async () => {
  const world = harness(answering({ RetrieveUserQuotaSummary: () => REFUSED }));
  const reading = world.hub.readUsage();
  await flush();

  world.latest().fires("exit");

  await expect(reading).resolves.toEqual({
    status: "unavailable",
    message: "Antigravity stopped before answering.",
  });
});

test("a machine with no Antigravity is not asked again on every read", async () => {
  const world = harness(answering({ RetrieveUserQuotaSummary: () => REFUSED }));
  const reading = world.hub.readUsage();
  await flush();
  world.latest().fires("error", NO_SUCH_PROGRAM);

  const missing = {
    status: "unavailable",
    message: "Antigravity could not be started. Check that the agy CLI is installed.",
    absent: true,
  };
  await expect(reading).resolves.toEqual(missing);
  // The repeat inside the cooldown says the same, so the item does not come and go.
  await expect(world.hub.readUsage()).resolves.toEqual(missing);
  expect(world.attempts()).toBe(1);

  await vi.advanceTimersByTimeAsync(60_000);
  const later = world.hub.readUsage();
  await flush();
  expect(world.attempts()).toBe(2);
  world.latest().fires("error");
  await later;
});

test("a CLI that is there but will not start is not taken for a missing one", async () => {
  const world = harness(answering({ RetrieveUserQuotaSummary: () => REFUSED }));
  const reading = world.hub.readUsage();
  await flush();

  world.latest().fires("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));

  await expect(reading).resolves.toEqual({
    status: "unavailable",
    message: "Antigravity could not be started. Check that the agy CLI is installed.",
  });
});

test("a launch that fails outright is not taken for a missing CLI either", async () => {
  let attempts = 0;
  const hub = new AntigravityHub(() => {
    attempts += 1;
    return Promise.reject(new Error("no local port"));
  });

  const first = await hub.readUsage();
  expect(first).toMatchObject({ status: "unavailable" });
  expect(first).not.toHaveProperty("absent");
  await expect(hub.readUsage()).resolves.toMatchObject({ status: "unavailable" });
  expect(attempts).toBe(1);
});

test("a read stopped part way through stops its hub and says it was stopped", async () => {
  const world = harness(answering({ RetrieveUserQuotaSummary: () => REFUSED }));
  const reading = world.hub.readUsage();
  await flush();

  world.hub.stop();
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(reading).resolves.toEqual({
    status: "unavailable",
    message: "The Antigravity read was stopped.",
  });
  expect(world.latest().killed).toBe(1);
});

test("a provider stopped while its hub is starting leaves nothing running behind it", async () => {
  const world = harness();
  world.hold();
  const reading = world.hub.readUsage();
  await flush();

  world.hub.stop();
  const orphan = world.release();

  await expect(reading).resolves.toMatchObject({ status: "unavailable" });
  expect(world.latest().killed).toBe(1);
  expect(orphan.process).toBe(world.latest());
  expect(world.calls).toEqual([]);
});

test("being stopped is not failing to start, and does not cost the respawn cooldown", async () => {
  const world = harness();
  world.hold();
  const reading = world.hub.readUsage();
  await flush();
  world.hub.stop();
  world.release();
  await reading;

  await expect(world.hub.readUsage()).resolves.toMatchObject({ status: "ok" });
  expect(world.attempts()).toBe(2);
});

test("a disposed provider rules out every later read", async () => {
  const world = harness();
  world.hub.dispose();

  await expect(world.hub.readUsage()).resolves.toMatchObject({ status: "unavailable" });
  expect(world.attempts()).toBe(0);
});
