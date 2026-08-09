import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { claudeDirectory } from "./claude";
import { isRecord, validLabel } from "./usage";

const CREDENTIALS_FILE = ".credentials.json";
const MAX_SECRET_CHARS = 64 * 1024;

/** Reads credential JSON from a platform-specific store. */
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
      // `lstat` rejects symlinks so credentials are read only from the expected regular file.
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

/** `blocked` includes an unanswered or denied macOS keychain authorization prompt. */
export type KeychainResult =
  | { status: "found"; secret: string }
  | { status: "missing" }
  | { status: "blocked" };

export type KeychainRead = () => Promise<KeychainResult>;

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** Avoids repeated authorization prompts while allowing a later retry after an accidental denial. */
const KEYCHAIN_BLOCKED_COOLDOWN_MS = 30 * 60_000;
/**
 * `/usr/bin/security` exposes OSStatus through an eight-bit exit code. `errSecItemNotFound`
 * (-25300) becomes 44. Other non-zero values can represent denial, a locked keychain, or another
 * access failure and therefore enter the blocked cooldown.
 */
const ITEM_NOT_FOUND = 44;

/** Converts process output into a platform-independent result. */
export function keychainOutcome(exitCode: number | null, secret: string): KeychainResult {
  const trimmed = secret.trim();
  if (exitCode === 0) {
    return trimmed ? { status: "found", secret: trimmed } : { status: "missing" };
  }
  return exitCode === ITEM_NOT_FOUND ? { status: "missing" } : { status: "blocked" };
}

/**
 * Reads Claude Code's login-keychain item with the system `security` tool. The absolute executable
 * path, argument array, and absence of a shell prevent PATH substitution and command parsing.
 * `find-generic-password` is read-only, and the bundle audit rejects other password verbs.
 * Keychain details from stderr are discarded; only stdout and the exit code are interpreted.
 */
export function readKeychain(service: string = KEYCHAIN_SERVICE): Promise<KeychainResult> {
  return new Promise((resolve) => {
    // Match by service only. The login keychain is already user-specific, while an account filter
    // could exclude an item stored under a different account attribute.
    const child = spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let secret = "";
    let settled = false;
    /**
     * Settles on the first process result, size limit, or timeout. The flag also guards against a
     * stream chunk already in flight after process listeners are removed.
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
    // Bound an unanswered authorization prompt so extension refresh does not wait indefinitely.
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
 * Checks the file before the macOS keychain because Claude Code can use the file when no login
 * keychain is available, such as over SSH. `DEFAULT_SOURCES` retains the returned keychain source
 * so its blocked-prompt cooldown survives between reads.
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
 * Names Claude Code rather than the unrelated desktop-app sign-in. Both Claude Code CLI and its VS
 * Code extension use this credential store. On macOS, the same result can also mean that keychain
 * access was not allowed, so the message includes that condition.
 */
export function noSignInMessage(platform: NodeJS.Platform = process.platform): string {
  const remedy = "Sign in to the CLI or extension";
  return platform === "darwin"
    ? `No Claude Code sign-in was found. ${remedy}, and allow the prompt.`
    : `No Claude Code sign-in was found. ${remedy}.`;
}

export function hasExpired(credentials: ClaudeCredentials): boolean {
  return credentials.expiresAt !== null && credentials.expiresAt <= Date.now();
}

/**
 * Reads but never refreshes Claude Code's token. Refresh rotates the stored token, so competing
 * with Claude Code could invalidate its own session.
 *
 * A live credential from a later source takes precedence over an expired earlier one. If no live
 * credential exists, returning the expired value lets the caller distinguish expiry from no sign-in.
 */
export async function readClaudeCredentials(
  sources: readonly CredentialSource[] = DEFAULT_SOURCES,
): Promise<ClaudeCredentials | null> {
  let expired: ClaudeCredentials | null = null;
  for (const source of sources) {
    // Read sequentially so a successful file read avoids starting the keychain child process.
    // oxlint-disable-next-line no-await-in-loop
    const credentials = parseCredentials(await source());
    if (credentials && !hasExpired(credentials)) {
      return credentials;
    }
    expired ??= credentials;
  }
  return expired;
}
