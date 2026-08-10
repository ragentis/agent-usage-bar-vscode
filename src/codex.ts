import * as os from "node:os";
import * as path from "node:path";

/**
 * Transcript writes signal local activity only; account percentages come from the app server.
 */
export function codexSessionsPath(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}
