import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Tests run inside the Workers runtime (workerd) via Miniflare, so HTMLRewriter,
// AbortSignal.timeout and the real fetch semantics match production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // No remote bindings exist; keep the pool fully local and offline.
      remoteBindings: false,
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
