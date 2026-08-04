import * as os from "node:os";
import * as path from "node:path";

export function claudeDirectory(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * Claude Code appends to a session transcript on every turn, which makes this directory a reliable
 * "the agent just did something" signal. Nothing is read out of these files: the usage numbers come
 * from the account API, and local token counts do not map onto plan percentages once caching,
 * thinking, and model mix are involved.
 */
export function claudeSessionsPath(): string {
  return path.join(claudeDirectory(), "projects");
}
