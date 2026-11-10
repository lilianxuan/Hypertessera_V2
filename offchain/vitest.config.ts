import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    // Each integration suite's beforeAll deploys the whole W1-W4 stack through three `forge script`
    // runs. That comfortably exceeds 30s on a cold cache or a loaded machine, and when the suites
    // run back to back (test:integration) the later ones were timing out rather than failing on
    // anything real.
    hookTimeout: 180_000,
  },
});
