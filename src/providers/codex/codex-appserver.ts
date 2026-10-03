import { spawn } from "node:child_process";
import { unavailable, UnstartedWindows, type ProviderResult } from "../../usage";
import { isNotFound, isRecord, validMessage } from "../../validation";
import { resolveCodexBinary } from "./codex-binary";
import { parseRateLimitsResponse } from "./codex-rate-limits";

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

/** Marks a start that failed because no Codex program exists where one was looked for. */
class CodexMissing extends Error {}

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
  on(event: "error" | "exit", listener: (error?: unknown) => void): void;
  removeAllListeners(): void;
  kill(): void;
}

export type LaunchCodex = () => Promise<CodexProcess>;

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
  private readonly unstarted = new UnstartedWindows();

  constructor(
    private readonly onExternalUpdate: () => void,
    private readonly launch: LaunchCodex = launchCodex,
  ) {}

  /** A later read starts a fresh process. */
  stop(): void {
    this.teardown(new Error("The Codex app server was stopped."));
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /**
   * A read without a snapshot stops the app server. It loads credentials once at startup, so a
   * signed-out or failing process keeps answering the same way. The next read starts a new one.
   */
  async readUsage(): Promise<ProviderResult> {
    try {
      await this.ensureStarted();
      const result = await this.request("account/rateLimits/read");
      const snapshot = parseRateLimitsResponse(result, new Date());
      if (snapshot) {
        return { status: "ok", snapshot: this.unstarted.withoutRollingResets(snapshot) };
      }
      this.stop();
      return unavailable("Codex reported no usage windows. Sign in to Codex.");
    } catch (error) {
      this.stop();
      const message =
        error instanceof Error ? error.message : "The Codex app server is unreachable.";
      return {
        status: "unavailable",
        message,
        verbatim: error instanceof CodexSaid,
        ...(error instanceof CodexMissing ? { absent: true } : {}),
      };
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
    child.on("error", (error) => {
      const message = "The Codex CLI could not be started. Check that Codex is installed.";
      this.teardown(isNotFound(error) ? new CodexMissing(message) : new Error(message));
    });
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
