import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveCodexBinary } from "../src/providers/codex/codex-binary";

/**
 * Injectable home and platform let every CI runner exercise all layouts. System-wide candidates
 * cannot be staged, so exclude them independently of the tools installed on a runner.
 */

let home = "";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === "/usr/local/bin/codex" || args[0] === "/opt/homebrew/bin/codex") {
        return Promise.reject(new Error("No system-wide install"));
      }
      return actual.stat(...args);
    },
  };
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-usage-bar-home-"));
  // Keep Windows candidates inside the temporary home on every runner.
  vi.stubEnv("LOCALAPPDATA", path.join(home, "AppData", "Local"));
  // One entry, so the runner's own PATH and its separator stay out of the Windows cases.
  vi.stubEnv("PATH", path.join(home, "npm"));
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

  await aged(alphabeticallyFirst, new Date());
  await aged(alphabeticallyLast, new Date(1));
  expect(await resolveCodexBinary(home, "win32")).toBe(alphabeticallyFirst);
});

test("with no install found, the bare name is left for PATH to resolve", async () => {
  expect(await resolveCodexBinary(home, "win32")).toBe("codex");
});

const NPM_PACKAGE = ["npm", "node_modules", "@openai", "codex", "node_modules", "@openai"];

test("an npm install is run by its native binary, because its shim on PATH cannot be spawned", async () => {
  await install("npm", "codex.cmd");
  const native = await install(
    ...NPM_PACKAGE,
    "codex-win32-arm64",
    "vendor",
    "aarch64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  expect(await resolveCodexBinary(home, "win32")).toBe(native);

  const plugin = await install(".codex", "plugins", ".plugin-appserver", "codex.exe");
  expect(await resolveCodexBinary(home, "win32")).toBe(native);
  expect(plugin).not.toBe(native);

  const installed = await install(...WINDOWS_BIN, "abc123", "codex.exe");
  expect(await resolveCodexBinary(home, "win32")).toBe(installed);
});

test("a shim with no native binary beside it is not handed to spawn", async () => {
  await install("npm", "codex.cmd");
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

test.each([
  ["win32", "x64", "windows-x86_64", "codex.exe"],
  ["win32", "arm64", "windows-aarch64", "codex.exe"],
  ["linux", "x64", "linux-x86_64", "codex"],
  ["linux", "arm64", "linux-aarch64", "codex"],
  ["darwin", "x64", "macos-x86_64", "codex"],
  ["darwin", "arm64", "macos-aarch64", "codex"],
] as const)(
  "the IDE copy is found on %s %s without a CLI on PATH",
  async (platform, architecture, target, name) => {
    const extensionDirectory = path.join(
      home,
      "custom editor extensions",
      "openai.chatgpt-26.1007.21434",
    );
    const binary = await install(
      "custom editor extensions",
      "openai.chatgpt-26.1007.21434",
      "bin",
      target,
      name,
    );
    expect(await resolveCodexBinary(home, platform, extensionDirectory, architecture)).toBe(binary);
  },
);

test("existing desktop, npm and plugin installs retain priority over the IDE copy", async () => {
  const extensionDirectory = path.join(home, "editor extension");
  await install("editor extension", "bin", "windows-x86_64", "codex.exe");
  const plugin = await install(".codex", "plugins", ".plugin-appserver", "codex.exe");
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "x64")).toBe(plugin);

  await install("npm", "codex.cmd");
  const npm = await install(
    ...NPM_PACKAGE,
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "x64")).toBe(npm);

  const desktop = await install(...WINDOWS_BIN, "abc123", "codex.exe");
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "x64")).toBe(desktop);
});

test("a native Unix install retains priority over the IDE copy", async () => {
  const extensionDirectory = path.join(home, "editor extension");
  await install("editor extension", "bin", "linux-x86_64", "codex");
  const native = await install(".local", "bin", "codex");
  expect(await resolveCodexBinary(home, "linux", extensionDirectory, "x64")).toBe(native);
});

test("an absent, incomplete or non-file IDE binary leaves the PATH fallback intact", async () => {
  const extensionDirectory = path.join(home, "editor extension");
  expect(await resolveCodexBinary(home, "win32", undefined, "x64")).toBe("codex");
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "x64")).toBe("codex");

  await fs.mkdir(path.join(extensionDirectory, "bin", "windows-x86_64", "codex.exe"), {
    recursive: true,
  });
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "x64")).toBe("codex");
});

test("a different architecture or unsupported platform is never selected", async () => {
  const extensionDirectory = path.join(home, "editor extension");
  await install("editor extension", "bin", "windows-x86_64", "codex.exe");
  await install("editor extension", "bin", "linux-x86_64", "codex");
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "arm64")).toBe("codex");
  expect(await resolveCodexBinary(home, "win32", extensionDirectory, "ia32")).toBe("codex");
  expect(await resolveCodexBinary(home, "freebsd", extensionDirectory, "x64")).toBe("codex");
});
