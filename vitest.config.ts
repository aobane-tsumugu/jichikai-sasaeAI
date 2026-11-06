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
            // 同時実行数が異なるWorkersとは実行順を分ける。
            sequence: { groupOrder: 0 },
            environment: "node",
            pool: "forks",
            include: nodeTests,
            // 全ソースのSQLを2回検査する。単純な関数1回分の既定の5秒では足りない。
            testTimeout: 30_000,
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
            sequence: { groupOrder: 1 },
            // D1の移行とHTTPの通しが重なりすぎないよう、同時実行数に上限を置く。
            maxWorkers: 2,
            // HTTP・D1・R2を繰り返す通し試験の上限。
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
