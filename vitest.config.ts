import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const nodeTests = ["test/ward-scope.test.ts"];

export default defineConfig(async () => {
  // migrations/ の全部を試験の D1 に入れる（束の番号順）
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          // TypeScriptコンパイラによる静的検査はNode.jsで動かす。
          // Workersのメモリ上限とD1の準備を持ち込まない。
          test: {
            name: "node",
            testTimeout: 30_000,
            environment: "node",
            pool: "forks",
            include: nodeTests,
          },
        },
        {
          // このプラグインを親に置くとNode.js側にも適用される。
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "workers",
            testTimeout: 30_000,
            setupFiles: ["./test/apply-migrations.ts"],
            include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
            exclude: [...configDefaults.exclude, ...nodeTests],
          },
        },
      ],
    },
  };
});
