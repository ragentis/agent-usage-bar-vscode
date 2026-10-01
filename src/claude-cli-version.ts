import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The service includes limit resets only for a Claude Code CLI user agent at or above a version
 * floor. The pinned value must be a published release; a newer installed CLI replaces it.
 */
export const PINNED_CLI_VERSION = "2.1.285";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function compareVersions(left: string, right: string): number {
  const rightParts = right.split(".").map(Number);
  return (
    left
      .split(".")
      .map((part, index) => Number(part) - (rightParts[index] ?? 0))
      .find((delta) => delta !== 0) ?? 0
  );
}

export function newestCliVersion(candidates: readonly unknown[]): string {
  return candidates
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && VERSION_PATTERN.test(candidate),
    )
    .reduce(
      (newest, candidate) => (compareVersions(candidate, newest) > 0 ? candidate : newest),
      PINNED_CLI_VERSION,
    );
}

/** The native installer keeps one entry per installed release, named by its version. */
export async function nativeCliVersions(home: string = os.homedir()): Promise<string[]> {
  try {
    return await fs.readdir(path.join(home, ".local", "share", "claude", "versions"));
  } catch {
    return [];
  }
}
