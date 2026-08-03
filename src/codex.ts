import * as os from "node:os";
import * as path from "node:path";

/**
 * Codex appends to a session transcript on every turn, which makes this directory a reliable
 * "the agent just did something" signal. Nothing is read out of these files: the numbers come
 * from the app server, which describes the whole account rather than this machine.
 */
export function codexSessionsPath(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}
