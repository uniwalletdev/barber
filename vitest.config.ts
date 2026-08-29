import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one Postgres database and mutate it, so they
    // must not run concurrently with each other.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
