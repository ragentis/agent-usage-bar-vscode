import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export function claudeDirectory(): string {
  return path.join(os.homedir(), ".claude");
}

/** The native installer keeps one entry per installed release, named by its version. */
export async function nativeCliVersions(home: string = os.homedir()): Promise<string[]> {
  try {
    return await fs.readdir(path.join(home, ".local", "share", "claude", "versions"));
  } catch {
    return [];
  }
}

/**
 * Transcript writes signal local activity only; account percentages come from the API because local
 * token counts do not capture caching, thinking, or model mix.
 */
export function claudeSessionsPath(): string {
  return path.join(claudeDirectory(), "projects");
}
