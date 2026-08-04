import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveCodexBinary } from "../src/codex-appserver";

/**
 * Where Codex installs itself is the only part of this extension that differs per platform, and a
 * layout only one machine can check is a layout nobody checks. The home and the platform are both
 * parameters, so every runner in the CI matrix walks all three sets of candidates.
 *
 * The absolute Unix candidates — `/usr/local/bin`, `/opt/homebrew/bin` — belong to the machine and
 * cannot be staged, so nothing here asserts what happens when no candidate exists on Unix. What is
 * asserted is the order, which is the part that decides between two installs.
 */

let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-home-"));
  // Pinned into the temp home, so the Windows candidates do not reach the real one on a Windows
  // runner and do exist at all on the other two.
  vi.stubEnv("LOCALAPPDATA", path.join(home, "AppData", "Local"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function install(...segments: string[]): Promise<string> {
  const binary = path.join(home, ...segments);
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, "", "utf8");
  return binary;
}

function aged(file: string, when: Date): Promise<void> {
  return fs.utimes(file, when, when);
}

const WINDOWS_BIN = ["AppData", "Local", "OpenAI", "Codex", "bin"];

test("the newest versioned install wins, because the directory name carries no order", async () => {
  const alphabeticallyFirst = await install(...WINDOWS_BIN, "aaaa1111", "codex.exe");
  const alphabeticallyLast = await install(...WINDOWS_BIN, "zzzz9999", "codex.exe");

  await aged(alphabeticallyFirst, new Date(1));
  await aged(alphabeticallyLast, new Date());
  expect(await resolveCodexBinary(home, "win32")).toBe(alphabeticallyLast);

  // Reversed, so what decides is proven to be the timestamp rather than the name it sorts under.
  await aged(alphabeticallyFirst, new Date());
  await aged(alphabeticallyLast, new Date(1));
  expect(await resolveCodexBinary(home, "win32")).toBe(alphabeticallyFirst);
});

test("with no install found, the bare name is left for PATH to resolve", async () => {
  expect(await resolveCodexBinary(home, "win32")).toBe("codex");
});

test("the IDE plugin copy is the last resort, not the first choice", async () => {
  const plugin = await install(".codex", "plugins", ".plugin-appserver", "codex.exe");
  expect(await resolveCodexBinary(home, "win32")).toBe(plugin);

  const installed = await install(...WINDOWS_BIN, "abc123", "codex.exe");
  expect(await resolveCodexBinary(home, "win32")).toBe(installed);
});

test("the unix candidates are tried in order, the agent's own install first", async () => {
  const shared = await install(".local", "bin", "codex");
  expect(await resolveCodexBinary(home, "linux")).toBe(shared);
  expect(await resolveCodexBinary(home, "darwin")).toBe(shared);

  const own = await install(".codex", "bin", "codex");
  expect(await resolveCodexBinary(home, "linux")).toBe(own);
  expect(await resolveCodexBinary(home, "darwin")).toBe(own);
});

test("a directory sitting where the binary should be is not mistaken for one", async () => {
  const impostor = path.join(home, ".codex", "bin", "codex");
  await fs.mkdir(impostor, { recursive: true });
  const real = await install(".local", "bin", "codex");

  expect(await resolveCodexBinary(home, "linux")).toBe(real);
});

test("a versioned directory holding no binary is passed over", async () => {
  await fs.mkdir(path.join(home, ...WINDOWS_BIN, "empty"), { recursive: true });
  const real = await install(...WINDOWS_BIN, "complete", "codex.exe");

  expect(await resolveCodexBinary(home, "win32")).toBe(real);
});
