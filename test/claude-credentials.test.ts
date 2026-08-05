import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  fileSource,
  hasExpired,
  credentialSources,
  keychainOutcome,
  readKeychain,
  keychainSource,
  noSignInMessage,
  parseCredentials,
  readClaudeCredentials,
  type CredentialSource,
  type KeychainResult,
} from "../src/claude-credentials";

/**
 * Where the sign-in is kept is the one thing about this extension that differs per platform, and
 * the macOS half is a child process holding a secret. Everything below is written so that neither
 * the secret nor anything the keychain says about it can end up somewhere it was not meant to be.
 */

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-credentials-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function stored(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "secret-token",
      expiresAt: Date.now() + 3_600_000,
      subscriptionType: "max",
      ...overrides,
    },
  });
}

function write(contents: string): Promise<void> {
  return fs.writeFile(path.join(directory, ".credentials.json"), contents, "utf8");
}

function keychain(...answers: KeychainResult[]): { source: CredentialSource; asked: () => number } {
  let asked = 0;
  const source = keychainSource(() => {
    asked += 1;
    return Promise.resolve(
      answers[Math.min(asked - 1, answers.length - 1)] ?? { status: "missing" },
    );
  });
  return { source, asked: () => asked };
}

test("the stored sign-in is read, and nothing unusable is mistaken for one", () => {
  expect(parseCredentials(stored())).toMatchObject({ accessToken: "secret-token", plan: "max" });
  expect(parseCredentials(null)).toBeNull();
  expect(parseCredentials("not json")).toBeNull();
  expect(parseCredentials(JSON.stringify({ claudeAiOauth: { expiresAt: 1 } }))).toBeNull();
  expect(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
  // An unreadable expiry is not an expiry: the token is tried, and the service decides.
  expect(parseCredentials(stored({ expiresAt: "soon" }))?.expiresAt).toBeNull();
});

test("the file is read only when it is a file, and only while it is a plausible size", async () => {
  const source = fileSource(directory);
  expect(await source()).toBeNull();

  await write(stored());
  expect(await source()).toContain("secret-token");

  await write("x".repeat(128 * 1024));
  expect(await source()).toBeNull();
});

test("the keychain is asked only when the file has nothing to say", async () => {
  const asked = keychain({ status: "found", secret: stored({ subscriptionType: "pro" }) });
  await write(stored());

  const credentials = await readClaudeCredentials([fileSource(directory), asked.source]);

  // The cheaper question first, and a child process not started at all where it is not needed.
  expect(credentials?.plan).toBe("max");
  expect(asked.asked()).toBe(0);
});

test("a sign-in the file no longer holds is found in the keychain", async () => {
  const asked = keychain({ status: "found", secret: stored({ subscriptionType: "pro" }) });

  const credentials = await readClaudeCredentials([fileSource(directory), asked.source]);

  expect(credentials).toMatchObject({ accessToken: "secret-token", plan: "pro" });
  expect(asked.asked()).toBe(1);
});

test("a file left behind by an older sign-in does not mask the live one", async () => {
  // The macOS case worth getting right: Claude Code moved to the keychain and the file it wrote
  // before that is still on disk, expired. Answering "expired" there sends the user to renew a
  // sign-in that is not the one being used.
  await write(stored({ expiresAt: Date.now() - 1 }));
  const asked = keychain({ status: "found", secret: stored({ subscriptionType: "pro" }) });

  const credentials = await readClaudeCredentials([fileSource(directory), asked.source]);

  expect(credentials?.plan).toBe("pro");
  expect(hasExpired(credentials!)).toBe(false);
});

test("an expired sign-in is still a better answer than none", async () => {
  await write(stored({ expiresAt: Date.now() - 1 }));

  const credentials = await readClaudeCredentials([fileSource(directory)]);

  // "Expired" and "never signed in" ask different things of whoever is reading the status bar.
  expect(credentials).not.toBeNull();
  expect(hasExpired(credentials!)).toBe(true);
});

test("a keychain that never answers is not asked again on the next interval", async () => {
  // An unanswered authorization prompt is what a read that does not come back looks like from
  // here. Asking again five minutes later would put the same prompt up again, and again.
  const asked = keychain({ status: "blocked" }, { status: "found", secret: stored() });

  expect(await readClaudeCredentials([asked.source])).toBeNull();
  expect(await readClaudeCredentials([asked.source])).toBeNull();
  expect(await readClaudeCredentials([asked.source])).toBeNull();
  expect(asked.asked()).toBe(1);
});

test("a keychain with no such item is asked again, because a sign-in may yet happen", async () => {
  const asked = keychain({ status: "missing" }, { status: "found", secret: stored() });

  expect(await readClaudeCredentials([asked.source])).toBeNull();
  expect(await readClaudeCredentials([asked.source])).toMatchObject({ plan: "max" });
  expect(asked.asked()).toBe(2);
});

test("on macOS the keychain is the second question, and elsewhere there is none", async () => {
  await write(stored());
  let asked = 0;
  const onDarwin = credentialSources("darwin", directory, () => {
    asked += 1;
    return Promise.resolve({ status: "missing" });
  });

  expect(onDarwin).toHaveLength(2);
  expect((await readClaudeCredentials(onDarwin))?.plan).toBe("max");
  // Answered by the file, so the child process was never started.
  expect(asked).toBe(0);

  expect(credentialSources("linux", directory)).toHaveLength(1);
  expect(credentialSources("win32", directory)).toHaveLength(1);
});

test.skipIf(process.platform !== "darwin")(
  "the real security tool reports an item that is not there as missing, not refused",
  async () => {
    // The assumption this whole reading rests on, checked against the tool itself rather than
    // asserted: an item that certainly does not exist must come back as code 44, so that a machine
    // with no Claude Code sign-in keeps asking cheaply instead of backing off for half an hour.
    // A service nobody has stored, so the answer does not turn on what this machine has installed.
    const outcome = await readKeychain(`agent-usage-bar-absent-${Date.now()}`);

    expect(outcome).toEqual({ status: "missing" });
  },
);

test("only the code for a missing item is a missing item", () => {
  // `security` exits with the OSStatus it got, masked to a byte: -25300 modulo 256 is 44. Reading
  // that one and treating every other refusal alike is what keeps a denied dialog — whichever code
  // it happens to carry — from being asked again, and again, on the next interval.
  expect(keychainOutcome(44, "")).toEqual({ status: "missing" });
  expect(keychainOutcome(128, "")).toEqual({ status: "blocked" });
  expect(keychainOutcome(51, "")).toEqual({ status: "blocked" });
  expect(keychainOutcome(36, "")).toEqual({ status: "blocked" });
  expect(keychainOutcome(null, "")).toEqual({ status: "blocked" });

  const secret = JSON.stringify({ ok: true });
  expect(keychainOutcome(0, ` ${secret}\n`)).toEqual({ status: "found", secret });
  // Success with nothing in it is not success, and is not a refusal either.
  expect(keychainOutcome(0, "   ")).toEqual({ status: "missing" });
});

test("what nothing found means is stated in terms the platform can act on", () => {
  expect(noSignInMessage("darwin")).toMatch(/keychain/);
  expect(noSignInMessage("win32")).not.toMatch(/keychain/);
  expect(noSignInMessage("linux")).not.toMatch(/keychain/);
  // Both still say the one thing that fixes it everywhere.
  expect(noSignInMessage("darwin")).toMatch(/Run Claude Code once/);
  expect(noSignInMessage("linux")).toMatch(/Run Claude Code once/);
});
