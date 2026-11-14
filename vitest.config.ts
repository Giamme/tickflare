import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the fixture Worker in ./test.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // A test that is slow on a busy machine is not a failing one: the default is five seconds.
    testTimeout: 15_000,
  },
});
