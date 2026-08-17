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
  validMessage,
  validUsedPercent,
  validWindowMinutes,
  type ProviderResult,
  type UsageSnapshot,
  type UsageWindow,
} from "./usage";

const REQUEST_TIMEOUT_MS = 10_000;
const RESPAWN_COOLDOWN_MS = 30_000;
// An unsplit buffer this large is not a plausible JSON-RPC stream; stdout is already decoded text.
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/**
 * Replaced by the bundler. Tests import this module without that substitution, so access must remain
 * guarded by `typeof`.
 */
// oxlint-disable-next-line no-underscore-dangle -- the dunder marks a build-time substitution
declare const __EXTENSION_VERSION__: unknown;
const VERSION = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "0.0.0-dev";

const CLIENT_INFO = { name: "agent-usage-bar", title: "Agent Usage Bar", version: VERSION };

/**
 * Marks app-server-authored text so the tooltip does not interpret a second sentence as a remedy.
 */
class CodexSaid extends Error {}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

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
 * Codex extension installs use changing content-hashed directories, so candidates must be searched.
 * A bare-name fallback still supports PATH installs; injectable home and platform cover every layout
 * on each CI runner.
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
    path.join(home, ".codex", "plugins", ".plugin-appserver", "codex"),
  ]) {
    // Preserve candidate priority without probing paths after the first match.
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
    windowMinutes: validWindowMinutes(value.windowDurationMins),
  };
}

/** Only an available credit can still be spent, so a spent or lapsed grant must not set the date. */
function nearestExpiry(resetCredits: Record<string, unknown>, now: Date): Date | null {
  if (!Array.isArray(resetCredits.credits)) {
    return null;
  }
  const expiries = resetCredits.credits
    .map((credit: unknown) =>
      isRecord(credit) && credit.status === "available" ? validDate(credit.expiresAt) : null,
    )
    .filter((expiry) => expiry !== null)
    .map((expiry) => expiry.getTime())
    .filter((expiry) => expiry > now.getTime());
  return expiries.length === 0 ? null : new Date(Math.min(...expiries));
}

function parseCredits(
  rateLimits: Record<string, unknown>,
  value: unknown,
  now: Date,
): { summary: string | null; expiresAt: Date | null } {
  const balance = creditBalance(rateLimits.credits);
  const resetCredits = isRecord(value) ? value : null;
  const count = typeof resetCredits?.availableCount === "number" ? resetCredits.availableCount : 0;
  const available = count > 0 ? `${count} reset credit${count === 1 ? "" : "s"}` : null;
  return {
    summary: [balance, available].filter((part) => part !== null).join(" · ") || null,
    expiresAt: resetCredits && available ? nearestExpiry(resetCredits, now) : null,
  };
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
  const credits = parseCredits(rateLimits, value.rateLimitResetCredits, fetchedAt);
  return {
    windows,
    plan: validLabel(rateLimits.planType),
    blocked: blockedReason(rateLimits),
    credits: credits.summary,
    creditsExpireAt: credits.expiresAt,
    fetchedAt,
    source: "codex-app-server",
  };
}

/** Long-lived JSON-RPC process; Codex retains ownership of credentials and their refresh. */
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
    private readonly launch: LaunchCodex = launchCodex,
  ) {}

  /**
   * Stops the current process while allowing a later read to start a fresh one.
   */
  stop(): void {
    this.teardown(new Error("The Codex app server was stopped."));
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /**
   * A read that produces no reading drops the app server. Credentials are loaded once at startup, so
   * a signed-out or failing process answers the same way until a fresh one replaces it, and an error
   * reply leaves it running and healthy-looking. The next read starts one that loads them again.
   */
  async readUsage(): Promise<ProviderResult> {
    try {
      await this.ensureStarted();
      const result = await this.request("account/rateLimits/read");
      const snapshot = parseRateLimitsResponse(result, new Date());
      if (snapshot) {
        return { status: "ok", snapshot };
      }
      this.stop();
      return {
        status: "unavailable",
        message: "Codex reported no usage windows. Sign in to Codex.",
      };
    } catch (error) {
      this.stop();
      const message =
        error instanceof Error ? error.message : "The Codex app server is unreachable.";
      return { status: "unavailable", message, verbatim: error instanceof CodexSaid };
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("The Codex app server was stopped."));
    }
    if (this.ready) {
      return this.ready;
    }
    if (Date.now() - this.lastSpawnFailedAt < RESPAWN_COOLDOWN_MS) {
      return Promise.reject(new Error("The Codex app server is not running."));
    }
    const generation = this.generation;
    this.ready = this.start().catch((error: unknown) => {
      // A stop during startup must not consume the respawn cooldown.
      if (this.generation === generation) {
        this.lastSpawnFailedAt = Date.now();
        this.teardown(
          error instanceof Error ? error : new Error("The Codex app server failed to start."),
        );
      }
      throw error;
    });
    return this.ready;
  }

  private async start(): Promise<void> {
    const generation = this.generation;
    const child = await this.launch();
    // A stop during async launch leaves the returned child unowned, so tear it down immediately.
    if (this.generation !== generation) {
      child.kill();
      throw new Error("The Codex app server was stopped.");
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // Draining stderr keeps the pipe from filling and stalling the child.
    child.stderr.resume();
    child.on("error", () =>
      this.teardown(
        new Error("The Codex CLI could not be started. Check that Codex is installed."),
      ),
    );
    child.on("exit", () => this.teardown(new Error("The Codex app server stopped.")));

    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.teardown(new Error("The Codex answer was too large."));
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
        const said = validMessage(message.error.message);
        pending.reject(
          said ? new CodexSaid(said) : new Error("The Codex app server returned an error."),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // Rolling updates are sparse; re-read the full snapshot instead of clearing omitted values.
    if (message.method === "account/rateLimits/updated") {
      this.onExternalUpdate();
    }
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("The Codex app server is not running."));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // Replace a silent server so later reads do not queue behind the same timed-out process.
      const timer = setTimeout(
        () => this.teardown(new Error("The Codex app server timed out.")),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          this.teardown(new Error("The Codex app server closed its input."));
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
