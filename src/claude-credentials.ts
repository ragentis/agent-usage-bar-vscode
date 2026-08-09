import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { claudeDirectory } from "./claude";
import { isRecord, validLabel } from "./usage";

const CREDENTIALS_FILE = ".credentials.json";
const MAX_SECRET_CHARS = 64 * 1024;

/**
 * Where Claude Code keeps the sign-in differs by platform: a file on Windows and Linux, the login
 * keychain on macOS. Both hold the same JSON, so only the fetching differs — hence a source is just
 * a function returning the stored text.
 */
export type CredentialSource = () => Promise<string | null>;

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number | null;
  plan: string | null;
}

export function fileSource(directory: string = claudeDirectory()): CredentialSource {
  return async () => {
    const credentialsPath = path.join(directory, CREDENTIALS_FILE);
    try {
      // `lstat`, so a symlink is described rather than followed: only a real file here is read.
      const file = await fs.lstat(credentialsPath);
      if (!file.isFile() || file.size > MAX_SECRET_CHARS) {
        return null;
      }
      return await fs.readFile(credentialsPath, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * `blocked` means the read never came back, which on macOS is what an unanswered authorization
 * prompt looks like from here.
 */
export type KeychainResult =
  | { status: "found"; secret: string }
  | { status: "missing" }
  | { status: "blocked" };

export type KeychainRead = () => Promise<KeychainResult>;

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** Long enough that a declined prompt is not raised again and again, short enough to forgive a
 *  misclick. */
const KEYCHAIN_BLOCKED_COOLDOWN_MS = 30 * 60_000;
/**
 * `security` exits with the OSStatus it got, masked to a byte: `errSecItemNotFound` is -25300, and
 * -25300 modulo 256 is 44. Only that code is read as "missing". Every other non-zero code — a
 * denied authorization dialog, a locked keychain, an item that exists but is not ours to see — is
 * treated as a refusal, because a missing item costs nothing to ask about again in five minutes
 * while a refusal asked about again in five minutes is the same dialog again.
 */
const ITEM_NOT_FOUND = 44;

/** Split out from the spawn so the reading of an answer can be tested on any platform. */
export function keychainOutcome(exitCode: number | null, secret: string): KeychainResult {
  const trimmed = secret.trim();
  // A tool that succeeded is never a refusal, whatever it did or did not print.
  if (exitCode === 0) {
    return trimmed ? { status: "found", secret: trimmed } : { status: "missing" };
  }
  return exitCode === ITEM_NOT_FOUND ? { status: "missing" } : { status: "blocked" };
}

/**
 * Asks the login keychain for the item Claude Code stores, through the tool macOS ships for it.
 *
 * Spawned rather than shelled, at an absolute path, with arguments as a list: nothing on PATH can
 * stand in for it and no argument can be read as a command. `find-generic-password` only reads;
 * this extension has no keychain verb that writes, and `audit:bundle` refuses a bundle carrying any
 * password verb but this one. stderr is discarded rather than reported, since it describes a
 * keychain item; only the exit code is used.
 */
export function readKeychain(service: string = KEYCHAIN_SERVICE): Promise<KeychainResult> {
  return new Promise((resolve) => {
    // Matched on the service alone. Other readers narrow to `-a $USER` as well, which can only find
    // less: a login keychain already belongs to one person, and an item stored under an account
    // attribute other than their user name would stop being found.
    const child = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let secret = "";
    let settled = false;
    /**
     * An answer, a failure to start, an oversized answer, or the timeout — the first to arrive
     * wins. The flag is what enforces that: `removeAllListeners` covers the process but not its
     * streams, so a chunk already in flight can still arrive after the end. The lint rule below
     * counts the handlers that can reach this, not the times it runs.
     */
    const finish = (result: KeychainResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.kill();
      // oxlint-disable-next-line promise/no-multiple-resolved -- guarded above, one call site
      resolve(result);
    };
    // An unanswered prompt would otherwise hold this read open for as long as it stands, and a
    // window is waiting on the read.
    const timer = setTimeout(() => finish({ status: "blocked" }), KEYCHAIN_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      secret += chunk;
      if (secret.length > MAX_SECRET_CHARS) {
        finish({ status: "missing" });
      }
    });
    child.stderr?.resume();
    child.on("error", () => finish({ status: "missing" }));
    child.on("close", (code) => finish(keychainOutcome(code, secret)));
  });
}

export function keychainSource(read: KeychainRead = readKeychain): CredentialSource {
  let blockedAt = 0;
  return async () => {
    if (Date.now() - blockedAt < KEYCHAIN_BLOCKED_COOLDOWN_MS) {
      return null;
    }
    const result = await read();
    if (result.status === "blocked") {
      blockedAt = Date.now();
      return null;
    }
    return result.status === "found" ? result.secret : null;
  };
}

/**
 * The file first even on macOS: it is the cheaper question, and Claude Code falls back to it where
 * the keychain is not available — over SSH, or on a machine with no login session. The keychain is
 * asked only when the file has nothing, so a macOS read normally costs one child process and a read
 * everywhere else costs none.
 *
 * Built once and held rather than assembled per read: the keychain source remembers an unanswered
 * prompt, and a source rebuilt each time would forget it each time.
 */
export function credentialSources(
  platform: NodeJS.Platform,
  directory?: string,
  keychain?: KeychainRead,
): readonly CredentialSource[] {
  const file = fileSource(directory);
  return platform === "darwin" ? [file, keychainSource(keychain)] : [file];
}

const DEFAULT_SOURCES = credentialSources(process.platform);

export function parseCredentials(raw: string | null): ClaudeCredentials | null {
  if (!raw) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.claudeAiOauth)) {
    return null;
  }
  const oauth = payload.claudeAiOauth;
  if (typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    return null;
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt:
      typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
        ? oauth.expiresAt
        : null,
    plan: validLabel(oauth.subscriptionType),
  };
}

/**
 * What is missing is Claude Code's own sign-in, which is worth naming precisely: the Claude desktop
 * app is a different application with a store of its own, and someone signed in to it has every
 * reason to read "no sign-in" as wrong. Both ways in are named because both write this one store —
 * the extension carries its own copy of the CLI, so neither is a prerequisite for the other.
 *
 * Nothing found still means something more on macOS, where a declined keychain prompt arrives here
 * as nothing found too. Hence the same statement either way and one clause more after it. It is
 * written as a condition rather than as a step, because the prompt is not the usual case: the item
 * is stored through the same tool this reads it with, which is a match macOS does not ask about.
 */
export function noSignInMessage(platform: NodeJS.Platform = process.platform): string {
  // Which CLI and which extension is the statement's to say, and it says it: a remedy naming them
  // again is the same words twice, and on macOS it is a line and a half of them.
  const remedy = "Sign in to the CLI or extension";
  return platform === "darwin"
    ? `No Claude Code sign-in was found. ${remedy}, and allow the prompt.`
    : `No Claude Code sign-in was found. ${remedy}.`;
}

export function hasExpired(credentials: ClaudeCredentials): boolean {
  return credentials.expiresAt !== null && credentials.expiresAt <= Date.now();
}

/**
 * Reads the token Claude Code already holds. Refreshing it is deliberately not implemented: a
 * refresh rotates the stored token, so racing Claude Code for it would sign the user out of their
 * own CLI. An expired token is reported as unavailable and left for Claude Code.
 *
 * An expired sign-in is not returned while another source may hold a live one — a file left by an
 * older Claude Code would otherwise mask the keychain the current one uses — but it beats returning
 * nothing, because "expired" and "not signed in" ask different things of the reader.
 */
export async function readClaudeCredentials(
  sources: readonly CredentialSource[] = DEFAULT_SOURCES,
): Promise<ClaudeCredentials | null> {
  let expired: ClaudeCredentials | null = null;
  for (const source of sources) {
    // Sequential on purpose: the second source is a child process, and asking it for something the
    // first already has would start one for nothing.
    // oxlint-disable-next-line no-await-in-loop
    const credentials = parseCredentials(await source());
    if (credentials && !hasExpired(credentials)) {
      return credentials;
    }
    expired ??= credentials;
  }
  return expired;
}
