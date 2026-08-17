import * as os from "node:os";
import * as path from "node:path";

/**
 * Transcript writes signal local activity only; account percentages come from the app server.
 */
export function codexSessionsPath(): string {
  return path.join(codexHomePath(), "sessions");
}

/**
 * Credentials are watched through their directory: Codex replaces `auth.json` by rename, which a
 * watch on the file itself would stop following.
 */
export function codexHomePath(): string {
  return path.join(os.homedir(), ".codex");
}
