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
import { validMessage } from "../src/usage";

/**
 * Platform stores are exercised without exposing the keychain secret or its diagnostic output.
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
  await write(stored({ expiresAt: Date.now() - 1 }));
  const asked = keychain({ status: "found", secret: stored({ subscriptionType: "pro" }) });

  const credentials = await readClaudeCredentials([fileSource(directory), asked.source]);

  expect(credentials?.plan).toBe("pro");
  expect(hasExpired(credentials!)).toBe(false);
});

test("an expired sign-in is still a better answer than none", async () => {
  await write(stored({ expiresAt: Date.now() - 1 }));

  const credentials = await readClaudeCredentials([fileSource(directory)]);

  expect(credentials).not.toBeNull();
  expect(hasExpired(credentials!)).toBe(true);
});

test("a keychain that never answers is not asked again on the next interval", async () => {
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
  expect(asked).toBe(0);

  expect(credentialSources("linux", directory)).toHaveLength(1);
  expect(credentialSources("win32", directory)).toHaveLength(1);
});

test.skipIf(process.platform !== "darwin")(
  "the real security tool reports an item that is not there as missing, not refused",
  async () => {
    // Verify the OSStatus mapping against the real macOS tool with a guaranteed-missing service.
    const outcome = await readKeychain(`agent-usage-bar-absent-${Date.now()}`);

    expect(outcome).toEqual({ status: "missing" });
  },
);

test("only the code for a missing item is a missing item", () => {
  expect(keychainOutcome(44, "")).toEqual({ status: "missing" });
  expect(keychainOutcome(128, "")).toEqual({ status: "blocked" });
  expect(keychainOutcome(51, "")).toEqual({ status: "blocked" });
  expect(keychainOutcome(36, "")).toEqual({ status: "blocked" });
  expect(keychainOutcome(null, "")).toEqual({ status: "blocked" });

  const secret = JSON.stringify({ ok: true });
  expect(keychainOutcome(0, ` ${secret}\n`)).toEqual({ status: "found", secret });
  expect(keychainOutcome(0, "   ")).toEqual({ status: "missing" });
});

test("what nothing found means is stated in terms the platform can act on", () => {
  expect(noSignInMessage("darwin")).toMatch(/allow the prompt/);
  expect(noSignInMessage("win32")).not.toMatch(/allow the prompt/);
  expect(noSignInMessage("linux")).not.toMatch(/allow the prompt/);
  for (const platform of ["darwin", "win32", "linux"] as const) {
    expect(noSignInMessage(platform)).toMatch(
      /^No Claude Code sign-in was found\. Sign in to the CLI or extension[.,]/,
    );
  }
});

test("a message says its piece inside what another window can read back", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    expect(validMessage(noSignInMessage(platform))).toBe(noSignInMessage(platform));
  }
});
