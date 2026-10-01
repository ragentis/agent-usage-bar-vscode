import * as os from "node:os";
import * as path from "node:path";

/** The one location Antigravity installs its CLI to, shared by its extension and its installer. */
export function antigravityBinary(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(home, ".gemini", "bin", platform === "win32" ? "agy.exe" : "agy");
}

/** Created by the CLI and by the Antigravity editor alike; `~/.gemini` alone may be the Gemini CLI's. */
export function antigravityDirectory(): string {
  return path.join(os.homedir(), ".gemini", "antigravity");
}

/**
 * Conversation writes signal local activity only; account percentages come from the hub. The hub
 * this extension starts writes beside this directory but not into it, so a read never triggers one.
 */
export function antigravityConversationsPath(): string {
  return path.join(antigravityDirectory(), "conversations");
}
