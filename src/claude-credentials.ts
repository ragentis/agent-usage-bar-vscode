import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { claudeDirectory } from "./claude";
import { isRecord, validLabel } from "./usage";

const CREDENTIALS_FILE = ".credentials.json";
const MAX_SECRET_CHARS = 64 * 1024;

/**
 * Where Claude Code keeps the sign-in differs by platform: a file on Windows and Linux, the login
 * keychain on macOS. Both hold the same JSON, so only the fetching differs — which is why a source
 * is a function returning the stored text and nothing more.
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
 * What asking the keychain can come to. `blocked` is the one worth naming: it means the read never
 * came back, which on macOS is what an unanswered authorization prompt looks like from here.
 */
export type KeychainResult =
  | { status: "found"; secret: string }
  | { status: "missing" }
  | { status: "blocked" };

export type KeychainRead = () => Promise<KeychainResult>;

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** Long enough that a prompt cannot become a drumbeat, short enough to forgive an accident. */
const KEYCHAIN_BLOCKED_COOLDOWN_MS = 30 * 60_000;
/**
 * `security` exits with the OSStatus it got, masked to a byte, so the answer is in the code rather
 * than in how long it took: `errSecItemNotFound` is -25300, and -25300 modulo 256 is 44.
 *
 * Only that one is read. Everything else non-zero — a denied authorization dialog, a locked
 * keychain, an item that exists but is not ours to see — is a refusal, and the difference that
 * matters is not which refusal it was: it is that a missing item costs nothing to ask about again
 * in five minutes, while a refusal asked about again in five minutes is the same dialog again.
 */
const ITEM_NOT_FOUND = 44;

/** Split out from the spawning so that the reading of an answer can be exercised on any platform. */
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
 * Spawned rather than shelled, at an absolute path, with the arguments as a list: nothing on PATH
 * can stand in for it and no part of an argument can be read as a command. `find-generic-password`
 * is a read; this extension has no keychain verb that writes, and `audit:bundle` fails the build if
 * one ever appears. Whatever the tool prints on stderr is about a keychain item and is never
 * repeated anywhere — the only thing taken from it is the exit code.
 */
export function readKeychain(service: string = KEYCHAIN_SERVICE): Promise<KeychainResult> {
  return new Promise((resolve) => {
    // Matched on the service alone. Other readers of this item narrow to `-a $USER` as well, which
    // can only ever find less: a login keychain belongs to one person already, and an item stored
    // under an account attribute that is not their user name would stop being found at all.
    const child = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let secret = "";
    let settled = false;
    /**
     * Four things can end this read — an answer, a failure to start, an answer too large to be
     * one, and the wait running out — and whichever arrives first is the one that counts. The flag
     * is what makes that so: `removeAllListeners` covers the process but not its streams, so a
     * chunk already in flight can still arrive after the end. The lint rule below counts the
     * handlers that can reach this, not the times it runs, which is what the flag already answers.
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
    // A prompt sitting unanswered would otherwise hold this read open for as long as it stands, and
    // the read is what a window is waiting on.
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
 * asked only when the file has nothing to say, so the ordinary macOS read costs one child process
 * and the ordinary read everywhere else costs none.
 *
 * Built once and held, rather than assembled per read: the keychain source remembers a prompt that
 * went unanswered, and a source rebuilt each time would forget it each time.
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
 * Nothing found means different things on different platforms, and the difference is the whole of
 * what the person reading it can do about it: everywhere else there is a file that is simply not
 * there yet, and on macOS the keychain may also have been asked and declined.
 */
export function noSignInMessage(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin"
    ? "No Claude Code sign-in was found; run Claude Code once, and allow keychain access if macOS asks"
    : "No Claude Code sign-in was found; run Claude Code once";
}

export function hasExpired(credentials: ClaudeCredentials): boolean {
  return credentials.expiresAt !== null && credentials.expiresAt <= Date.now();
}

/**
 * Reads the token Claude Code already holds. Refreshing it is deliberately not implemented:
 * a refresh rotates the stored token, so racing Claude Code for it would sign the user out
 * of their own CLI. An expired token is reported as unavailable and left for Claude Code.
 *
 * A sign-in that has expired is not the answer while another source may hold a live one — a file
 * left behind by an older Claude Code would otherwise mask the keychain the current one uses — but
 * it is a better answer than nothing, because "expired" and "not signed in" ask for different
 * things from the person reading the status bar.
 */
export async function readClaudeCredentials(
  sources: readonly CredentialSource[] = DEFAULT_SOURCES,
): Promise<ClaudeCredentials | null> {
  let expired: ClaudeCredentials | null = null;
  for (const source of sources) {
    // The order is the answer, and the second source is a child process: asking it for something
    // the first already has would be a process started for nothing.
    // oxlint-disable-next-line no-await-in-loop
    const credentials = parseCredentials(await source());
    if (credentials && !hasExpired(credentials)) {
      return credentials;
    }
    expired ??= credentials;
  }
  return expired;
}
