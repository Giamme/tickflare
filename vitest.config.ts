import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the fixture Worker in ./test.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      // How far test/random.test.ts searches: see the top of that file.
      miniflare: {
        bindings: {
          RANDOM_RUNS: process.env.RANDOM_RUNS ?? "",
          RANDOM_SEEDS: process.env.RANDOM_SEEDS ?? "",
          RANDOM_TRACE: process.env.RANDOM_TRACE ?? "",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // A test that is slow on a busy machine is not a failing one: the default is five seconds.
    testTimeout: 15_000,
  },
});
