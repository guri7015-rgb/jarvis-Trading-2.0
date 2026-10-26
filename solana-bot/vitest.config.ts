import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests must never reach the network. Providers take injected fetch/socket fakes.
    environment: "node",
    testTimeout: 10_000,
  },
});
