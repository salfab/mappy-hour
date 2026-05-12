import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default to Node for speed. Tests that need DOM APIs (canvas, document,
    // Image, etc.) opt-in per file via a top-of-file docblock:
    //   /**
    //    * @vitest-environment jsdom
    //    */
    // This keeps the >100 non-DOM tests on the lightweight Node runtime
    // (jsdom adds ~200ms cold start per test file).
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
