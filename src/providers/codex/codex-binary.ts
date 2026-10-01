import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

const NPM_WINDOWS_TARGETS = [
  ["codex-win32-x64", "x86_64-pc-windows-msvc"],
  ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
] as const;

/**
 * An npm install puts only a `codex.cmd` shim on PATH, and a `.cmd` cannot be spawned without a
 * shell. The package sits beside the shim and carries the native binary for the one architecture
 * npm installed.
 */
async function npmWindowsBinary(): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    // The first shim on PATH is the install a shell would run, so later entries are not probed.
    // oxlint-disable-next-line no-await-in-loop
    if (directory && (await exists(path.join(directory, "codex.cmd")))) {
      return npmNativeBinary(directory);
    }
  }
  return null;
}

async function npmNativeBinary(shimDirectory: string): Promise<string | null> {
  const scope = path.join(shimDirectory, "node_modules", "@openai", "codex", "node_modules");
  const binaries = await Promise.all(
    NPM_WINDOWS_TARGETS.map(async ([name, target]) => {
      const binary = path.join(scope, "@openai", name, "vendor", target, "bin", "codex.exe");
      return (await exists(binary)) ? binary : null;
    }),
  );
  return binaries.find((binary) => binary !== null) ?? null;
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
    const npm = await npmWindowsBinary();
    if (npm) {
      return npm;
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
