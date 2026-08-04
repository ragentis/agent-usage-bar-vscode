import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The watcher tests wait on the platform rather than on a clock of their own: each holds a
    // five-second deadline so that a slow backend is reported as the assertion it failed, not as a
    // runner timeout. Under the default of five seconds those deadlines are unreachable — the fixed
    // waits around them alone put a test past it — so the harness would kill the test first and say
    // only that it ran out of time. Everything else here finishes in milliseconds.
    testTimeout: 15_000,
  },
});
