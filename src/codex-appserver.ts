import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyWindow,
  isRecord,
  sortWindows,
  validDate,
  validLabel,
  validUsedPercent,
  type ProviderResult,
  type UsageSnapshot,
  type UsageWindow,
} from "./usage";

const REQUEST_TIMEOUT_MS = 10_000;
const RESPAWN_COOLDOWN_MS = 30_000;
// JSON-RPC frames are small, so an unsplit buffer this large means the stream is not what we
// expect. Counted in characters, not bytes: stdout is decoded as UTF-8 before it reaches here.
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/**
 * Replaced by the bundler from `package.json`. Typed as `unknown` and read through `typeof`
 * because the unit tests import this module with no define in place, where the name is simply
 * absent: anything but `typeof` would throw on the way in.
 */
// oxlint-disable-next-line no-underscore-dangle -- the dunder marks a build-time substitution
declare const __EXTENSION_VERSION__: unknown;
const VERSION = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "0.0.0-dev";

const CLIENT_INFO = { name: "agent-usage-bar", title: "Agent Usage Bar", version: VERSION };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The slice of a spawned process this needs, named here rather than imported: the lifecycle below
 * is the part worth testing — framing, timeouts, teardown — and a process the test can stand up is
 * all any of it ever asks for.
 */
export interface CodexProcess {
  stdin: { write(chunk: string, callback?: (error?: Error | null) => void): void };
  stdout: {
    setEncoding(encoding: "utf8"): void;
    on(event: "data", listener: (chunk: string) => void): void;
  };
  stderr: { resume(): void };
  on(event: "error" | "exit", listener: () => void): void;
  removeAllListeners(): void;
  kill(): void;
}

/** Finding the binary and starting it: one seam, because both are the machine answering back. */
export type LaunchCodex = () => Promise<CodexProcess>;

/** Newest install wins: the versioned directory name carries no ordering of its own. */
async function newestBinary(directory: string, executable: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = path.join(directory, entry.name, executable);
        try {
          return { candidate, modifiedAt: (await fs.stat(candidate)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  return (
    candidates
      .filter((entry) => entry !== null)
      .toSorted((left, right) => right.modifiedAt - left.modifiedAt)[0]?.candidate ?? null
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Codex installs itself under a content-hashed directory that changes on every update, so the
 * path cannot be hard coded. Falling back to the bare name lets a PATH install still work.
 *
 * The home directory and the platform are parameters because the layouts are the one part of this
 * extension that differs per platform, and a layout only one machine can check is a layout nobody
 * checks: every CI runner walks all three.
 */
export async function resolveCodexBinary(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const versioned = await newestBinary(
      path.join(localAppData, "OpenAI", "Codex", "bin"),
      "codex.exe",
    );
    if (versioned) {
      return versioned;
    }
    const plugin = path.join(home, ".codex", "plugins", ".plugin-appserver", "codex.exe");
    return (await exists(plugin)) ? plugin : "codex";
  }
  for (const candidate of [
    path.join(home, ".codex", "bin", "codex"),
    path.join(home, ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    // Last resort, mirroring Windows: the IDE plugin ships its own copy when no CLI is installed.
    path.join(home, ".codex", "plugins", ".plugin-appserver", "codex"),
  ]) {
    // The order is the answer: the first hit wins, so running these in parallel would stat paths
    // that never needed looking at.
    // oxlint-disable-next-line no-await-in-loop
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

function creditBalance(value: unknown): string | null {
  if (!isRecord(value) || value.hasCredits !== true) {
    return null;
  }
  if (value.unlimited === true) {
    return "unlimited";
  }
  return typeof value.balance === "number" && Number.isFinite(value.balance)
    ? String(value.balance)
    : validLabel(value.balance);
}

function blockedReason(rateLimits: Record<string, unknown>): string | null {
  if (rateLimits.spendControlReached === true) {
    return "Spend control reached";
  }
  // The reached-type values are backend-defined, so the raw label is surfaced rather than guessed at.
  const reached = validLabel(rateLimits.rateLimitReachedType);
  return reached ? `Rate limit reached: ${reached}` : null;
}

function parseWindow(value: unknown, fallback: "session" | "weekly"): UsageWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = validUsedPercent(value.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  // Never trust primary to mean "session": on a weekly-only plan primary is the weekly window.
  return {
    kind: classifyWindow(value.windowDurationMins, fallback),
    usedPercent,
    resetsAt: validDate(value.resetsAt),
  };
}

function creditSummary(rateLimits: Record<string, unknown>, resetCredits: unknown): string | null {
  const balance = creditBalance(rateLimits.credits);
  const available =
    isRecord(resetCredits) &&
    typeof resetCredits.availableCount === "number" &&
    resetCredits.availableCount > 0
      ? `${resetCredits.availableCount} reset credit${resetCredits.availableCount === 1 ? "" : "s"}`
      : null;
  return [balance, available].filter((part) => part !== null).join(" · ") || null;
}

export function parseRateLimitsResponse(value: unknown, fetchedAt: Date): UsageSnapshot | null {
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    return null;
  }
  const rateLimits = value.rateLimits;
  const windows = sortWindows(
    [
      parseWindow(rateLimits.primary, "session"),
      parseWindow(rateLimits.secondary, "weekly"),
    ].filter((window) => window !== null),
  );
  if (windows.length === 0) {
    return null;
  }
  return {
    windows,
    plan: validLabel(rateLimits.planType),
    blocked: blockedReason(rateLimits),
    credits: creditSummary(rateLimits, value.rateLimitResetCredits),
    fetchedAt,
    source: "codex-app-server",
  };
}

/**
 * Long-lived `codex app-server` process speaking JSON-RPC over stdio. Codex owns the account
 * credentials and their refresh, so no token is ever read or held here.
 */
async function launchCodex(): Promise<CodexProcess> {
  const binary = await resolveCodexBinary();
  return spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

export class CodexAppServer {
  private child: CodexProcess | null = null;
  private ready: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private lastSpawnFailedAt = 0;
  private disposed = false;
  /** Bumped by every teardown, so work started before one can tell that it was overtaken. */
  private generation = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly onExternalUpdate: () => void,
    /** Injected so the lifecycle can be exercised without a Codex install on the machine. */
    private readonly launch: LaunchCodex = launchCodex,
  ) {}

  /**
   * Ends the process without ruling out a later one, because switching the provider off is not
   * the same as being done with it: the next time it is switched on, the next read starts a
   * fresh server rather than paying for one that idled through the meantime.
   */
  stop(): void {
    this.teardown(new Error("The Codex app server was stopped"));
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  async readUsage(): Promise<ProviderResult> {
    try {
      await this.ensureStarted();
      const result = await this.request("account/rateLimits/read");
      const snapshot = parseRateLimitsResponse(result, new Date());
      return snapshot
        ? { status: "ok", snapshot }
        : {
            status: "unavailable",
            message: "Codex reported no rate-limit windows; sign in to Codex",
          };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The Codex app server could not be reached";
      return { status: "unavailable", message };
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("The Codex app server was stopped"));
    }
    if (this.ready) {
      return this.ready;
    }
    if (Date.now() - this.lastSpawnFailedAt < RESPAWN_COOLDOWN_MS) {
      return Promise.reject(new Error("The Codex app server is not running"));
    }
    const generation = this.generation;
    this.ready = this.start().catch((error: unknown) => {
      // Being stopped part way through starting is not a failure to start, and must not cost the
      // respawn cooldown: switching the provider back on should answer at once.
      if (this.generation === generation) {
        this.lastSpawnFailedAt = Date.now();
        this.teardown(
          error instanceof Error ? error : new Error("The Codex app server failed to start"),
        );
      }
      throw error;
    });
    return this.ready;
  }

  private async start(): Promise<void> {
    const generation = this.generation;
    const child = await this.launch();
    // Finding the binary and starting it walks the disk, and a provider switched off in the
    // meantime has already torn down everything there was to tear down. Keeping this one would
    // leave a child that nothing owns and nothing ever stops.
    if (this.generation !== generation) {
      child.kill();
      throw new Error("The Codex app server was stopped");
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // Draining stderr keeps the pipe from filling and stalling the child.
    child.stderr.resume();
    child.on("error", () => this.teardown(new Error("The Codex CLI could not be started")));
    child.on("exit", () => this.teardown(new Error("The Codex app server stopped")));

    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.teardown(new Error("The Codex app server sent an oversized message"));
      return;
    }
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handle(line);
      }
    }
  }

  private handle(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(
          new Error(validLabel(message.error.message) ?? "The Codex app server returned an error"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // A rolling update is documented as sparse, so merging it by hand risks clearing good values
    // with absent ones. Re-reading the full snapshot is both simpler and always correct.
    if (message.method === "account/rateLimits/updated") {
      this.onExternalUpdate();
    }
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("The Codex app server is not running"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // A server that misses one answer has stopped speaking, and dropping only the request would
      // leave every later read queued behind the same silent process until the window is reloaded.
      // Tearing it down here is what makes the next read start a fresh one.
      const timer = setTimeout(
        () => this.teardown(new Error("The Codex app server did not answer in time")),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          this.teardown(new Error("The Codex app server could not be written to"));
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private teardown(reason: Error): void {
    this.generation++;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.buffer = "";
    this.ready = null;
    const child = this.child;
    this.child = null;
    child?.removeAllListeners();
    child?.kill();
  }
}
