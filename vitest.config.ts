import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // migrations/ の全部を試験の D1 に入れる（束の番号順）
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  };
});
