import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Real watcher tests own a five-second assertion deadline, so the runner must outlive it.
    testTimeout: 15_000,
  },
});
