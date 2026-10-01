import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import * as os from "node:os";
import { antigravityBinary } from "./antigravity";
import {
  sortWindows,
  unavailable,
  type ProviderResult,
  type UnavailableResult,
  type UsageSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./usage";
import {
  isNotFound,
  isRecord,
  validDate,
  validLabel,
  validMessage,
  validUsedPercent,
} from "./validation";

const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;
const RESPAWN_COOLDOWN_MS = 30_000;

/** The audit pins this literal; the port and path are appended at runtime. */
const HUB_ORIGIN = "http://127.0.0.1";
const SERVICE_PATH = "/exa.language_server_pb.LanguageServerService/";

const NOT_STARTED = "Antigravity could not be started. Check that the agy CLI is installed.";
const STOPPED = "The Antigravity read was stopped.";
const TIMED_OUT = "Antigravity did not answer in time.";

const WINDOWS = new Map<string, { kind: WindowKind; minutes: number }>([
  ["5h", { kind: "session", minutes: 300 }],
  ["weekly", { kind: "weekly", minutes: 10_080 }],
]);

export interface HubReply {
  status: number;
  body: unknown;
}

export interface HubProcess {
  on(event: "error" | "exit", listener: (error?: unknown) => void): void;
  removeAllListeners(): void;
  kill(): void;
}

export interface Hub {
  process: HubProcess;
  /** Rejects while the hub is not listening yet; any HTTP answer resolves, whatever its status. */
  call(method: string, body?: Record<string, unknown>): Promise<HubReply>;
}

export type LaunchHub = () => Promise<Hub>;

function groupLabel(value: unknown): string | null {
  const name = validLabel(value);
  return name === null ? null : name.replace(/\s+models$/i, "") || name;
}

/**
 * The hub answers in proto3 JSON, which omits a zero. A fully used bucket therefore has a reset
 * time and no fraction. A bucket with neither is rejected.
 */
function remainingFraction(value: unknown, resetsAt: Date | null): number | null {
  if (value === undefined) {
    return resetsAt ? 0 : null;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function parseBucket(value: unknown, label: string | null): UsageWindow | null {
  if (!isRecord(value) || typeof value.window !== "string") {
    return null;
  }
  const shape = WINDOWS.get(value.window);
  const resetsAt = validDate(value.resetTime);
  const remaining = remainingFraction(value.remainingFraction, resetsAt);
  if (!shape || remaining === null) {
    return null;
  }
  const usedPercent = validUsedPercent((1 - remaining) * 100);
  return usedPercent === null
    ? null
    : { kind: shape.kind, usedPercent, resetsAt, windowMinutes: shape.minutes, label };
}

function parseGroup(value: unknown): UsageWindow[] {
  if (!isRecord(value) || !Array.isArray(value.buckets)) {
    return [];
  }
  const label = groupLabel(value.displayName);
  return value.buckets
    .map((bucket: unknown) => parseBucket(bucket, label))
    .filter((window) => window !== null);
}

export function parseQuotaSummary(value: unknown, fetchedAt: Date): UsageSnapshot | null {
  const response = isRecord(value) ? value.response : null;
  if (!isRecord(response) || !Array.isArray(response.groups)) {
    return null;
  }
  const windows = sortWindows(response.groups.flatMap(parseGroup));
  return windows.length === 0
    ? null
    : { windows, plan: null, blocked: null, credits: null, fetchedAt, source: "antigravity-hub" };
}

/** The reply also contains the account holder's name and email; only the plan is read. */
export function parsePlan(value: unknown): string | null {
  const status = isRecord(value) && isRecord(value.userStatus) ? value.userStatus.planStatus : null;
  const info = isRecord(status) ? status.planInfo : null;
  return isRecord(info) ? validLabel(info.planName) : null;
}

/** Proto3 JSON omits `false`, so only an explicit `true` counts as signed in. */
function signedIn(value: unknown): boolean {
  return isRecord(value) && isRecord(value.authResult) && value.authResult.hasValidAuth === true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("No local port is available."));
        }
      });
    });
  });
}

/**
 * Starts a private hub with a token generated here, so no existing hub's token is read. The hub
 * listens only when `AGY_ENABLE_HUB` is set. `ANTIGRAVITY_VSCODE_HOST` is what Google's extension
 * sets; nothing here opens the sign-in URLs the hub prints. The null log file prevents a log file
 * per start.
 */
async function launchHub(): Promise<Hub> {
  const port = await freePort();
  const token = randomUUID();
  const child = spawn(
    antigravityBinary(),
    [
      "--hub",
      `--hub-port=${port}`,
      "--app_data_dir=antigravity",
      `--csrf_token=${token}`,
      `--log-file=${os.devNull}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, AGY_ENABLE_HUB: "1", ANTIGRAVITY_VSCODE_HOST: "1" },
    },
  );
  // Draining both pipes keeps them from filling and stalling the child.
  child.stdout.resume();
  child.stderr.resume();
  return {
    process: child,
    call: async (method, request = {}) => {
      const response = await fetch(`${HUB_ORIGIN}:${port}${SERVICE_PATH}${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-codeium-csrf-token": token,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One hub per read: started, asked, and stopped. A running hub uses over a hundred megabytes and
 * answers repeated calls from its cache, so keeping it would cost memory and return stale
 * readings. An instance runs one hub at a time.
 */
export class AntigravityHub {
  private child: HubProcess | null = null;
  private lastSpawnFailedAt = 0;
  /** Returned again during the cooldown, so the item's visibility does not change between reads. */
  private lastSpawnFailure = unavailable(NOT_STARTED);
  private disposed = false;
  /** Bumped by every stop, so a read started before one can tell that it was overtaken. */
  private generation = 0;

  constructor(
    private readonly launch: LaunchHub = launchHub,
    private readonly wait: (ms: number) => Promise<void> = delay,
  ) {}

  stop(): void {
    this.generation++;
    this.release();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  async readUsage(): Promise<ProviderResult> {
    const session = await this.session((hub) => this.ask(hub));
    return "value" in session ? session.value : session.failure;
  }

  /**
   * Runs `use` against a hub of its own, once that hub answers, and stops the hub afterwards.
   * Throws when no hub could be asked, and passes on whatever `use` throws.
   */
  async query<T>(use: (call: Hub["call"]) => Promise<T>): Promise<T> {
    const session = await this.session(async (hub) => {
      if (!(await this.firstReply(hub, "GetAuthStatus"))) {
        throw new Error(this.child === hub.process ? TIMED_OUT : STOPPED);
      }
      return use((method, body) => hub.call(method, body));
    });
    if ("value" in session) {
      return session.value;
    }
    throw new Error(session.failure.message);
  }

  private async session<T>(
    use: (hub: Hub) => Promise<T>,
  ): Promise<{ value: T } | { failure: UnavailableResult }> {
    if (this.disposed) {
      return { failure: unavailable(STOPPED) };
    }
    if (Date.now() - this.lastSpawnFailedAt < RESPAWN_COOLDOWN_MS) {
      return { failure: this.lastSpawnFailure };
    }
    const generation = this.generation;
    let hub: Hub;
    try {
      hub = await this.launch();
    } catch {
      return { failure: this.spawnFailed(false) };
    }
    // A stop during async launch leaves the returned process unowned, so stop it immediately.
    if (this.generation !== generation) {
      hub.process.kill();
      return { failure: unavailable(STOPPED) };
    }
    this.child = hub.process;
    const ended = new Promise<{ failure: UnavailableResult }>((resolve) => {
      // A missing binary is reported here rather than by `spawn` itself.
      hub.process.on("error", (error) => resolve({ failure: this.spawnFailed(isNotFound(error)) }));
      hub.process.on("exit", () =>
        resolve({ failure: unavailable("Antigravity stopped before answering.") }),
      );
    });
    try {
      return await Promise.race([use(hub).then((value) => ({ value })), ended]);
    } finally {
      if (this.child === hub.process) {
        this.release();
      }
    }
  }

  private spawnFailed(absent: boolean): UnavailableResult {
    this.lastSpawnFailedAt = Date.now();
    this.lastSpawnFailure = absent
      ? { status: "unavailable", message: NOT_STARTED, absent }
      : unavailable(NOT_STARTED);
    return this.lastSpawnFailure;
  }

  private async ask(hub: Hub): Promise<ProviderResult> {
    const reply = await this.firstReply(hub, "RetrieveUserQuotaSummary");
    if (!reply) {
      return unavailable(this.child === hub.process ? TIMED_OUT : STOPPED);
    }
    const snapshot = reply.status === 200 ? parseQuotaSummary(reply.body, new Date()) : null;
    if (snapshot) {
      return { status: "ok", snapshot: { ...snapshot, plan: await this.plan(hub) } };
    }
    if (!(await this.signedIn(hub))) {
      return unavailable("Antigravity is not signed in. Sign in to the CLI or extension.");
    }
    const said =
      reply.status !== 200 && isRecord(reply.body) ? validMessage(reply.body.message) : null;
    return said
      ? { status: "unavailable", message: said, verbatim: true }
      : unavailable("Antigravity reported no usage windows.");
  }

  /**
   * The hub refuses connections until it listens, so a rejected call means it is still starting.
   * Returns null when the wait runs out or the hub was stopped.
   */
  private async firstReply(hub: Hub, method: string): Promise<HubReply | null> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (this.child === hub.process) {
      try {
        // Each attempt depends on the previous one having failed.
        // oxlint-disable-next-line no-await-in-loop
        return await hub.call(method);
      } catch {
        if (Date.now() >= deadline) {
          return null;
        }
      }
      // oxlint-disable-next-line no-await-in-loop
      await this.wait(POLL_INTERVAL_MS);
    }
    return null;
  }

  private async plan(hub: Hub): Promise<string | null> {
    try {
      const reply = await hub.call("GetUserStatus");
      return reply.status === 200 ? parsePlan(reply.body) : null;
    } catch {
      return null;
    }
  }

  /** An answer that cannot be read is not evidence of a missing sign-in. */
  private async signedIn(hub: Hub): Promise<boolean> {
    try {
      const reply = await hub.call("GetAuthStatus");
      return reply.status !== 200 || signedIn(reply.body);
    } catch {
      return true;
    }
  }

  private release(): void {
    const child = this.child;
    this.child = null;
    child?.removeAllListeners();
    child?.kill();
  }
}
