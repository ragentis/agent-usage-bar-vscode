import * as os from "node:os";
import * as path from "node:path";

export function claudeDirectory(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * Transcript writes signal local activity only; account percentages come from the API because local
 * token counts do not capture caching, thinking, or model mix.
 */
export function claudeSessionsPath(): string {
  return path.join(claudeDirectory(), "projects");
}
