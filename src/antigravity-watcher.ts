import { antigravityConversationsPath } from "./antigravity";
import { listConversations } from "./antigravity-history";
import type { ProviderWatcher } from "./usage-bar";

/** File times and the clock are compared across a debounce, so a write is given this much slack. */
const WRITE_SLACK_MS = 1_000;

/**
 * Reading a conversation makes SQLite recreate its empty companion files, and the file watcher
 * reports that as a change. Reporting it would make every scan trigger another scan, so a change
 * counts only when a conversation was written since the previous change.
 */
export function realWritesOnly(
  watcher: ProviderWatcher,
  directory: string = antigravityConversationsPath(),
  now: () => number = Date.now,
): ProviderWatcher {
  return {
    start: (onChange) => {
      let seen = now();
      const report = async (since: number): Promise<void> => {
        if ((await listConversations(directory, since)).length > 0) {
          onChange();
        }
      };
      watcher.start(() => {
        const since = seen - WRITE_SLACK_MS;
        seen = now();
        void report(since);
      });
    },
    stop: () => watcher.stop(),
    dispose: () => watcher.dispose(),
  };
}
