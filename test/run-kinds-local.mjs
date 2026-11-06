// node test/run-kinds-local.mjs。npm testを使わず、本物のローカルWorkersへ全段を流す。
// D1/R2はメモリ内、AIは偽物。資格情報と外への通信を使わない。
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runKindsWalkthrough } from "../scripts/walkthrough-kinds.ts";

const output = resolve("test/.kinds-local");
mkdirSync(output, { recursive: true });
writeFileSync(output + "/.gitignore", "*\n", "utf8");
let mf;
try {
  await build({ entryPoints: ["test/kinds-local-worker.ts"], outfile: output + "/worker.mjs", bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*", "node:*"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: output + "/worker.mjs", compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"], r2Buckets: ["ORIGINALS"],
    bindings: { PUBLIC_BASE_URL: "http://localhost", DEMO_NOTICE: "資料と名前はすべて架空です。" },
    outboundService: () => new Response("ローカル確認では外へ接続しません", { status: 503 }),
  }));
  const db = await mf.getD1Database("DB");
  for (const filename of readdirSync("migrations").filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve("migrations", filename), "utf8").replace(/--[^\n]*/g, "").replace(/\r?\n/g, " ");
    await db.exec(sql);
  }
  const response = await mf.dispatchFetch("http://localhost/__kinds_setup", { method: "POST" });
  if (!response.ok) throw new Error("架空の区を準備できません");
  const setup = await response.json();
  const result = await runKindsWalkthrough({ base: "http://localhost", ...setup }, {
    fetch: (input, init) => mf.dispatchFetch(String(input), init),
    waitMs: 15_000, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 100))),
    log: line => console.log(line),
    record: report => writeFileSync(output + "/evidence.md", "確認環境: ローカルのworkerd。AIの通信は偽物。stagingへの接続なし。\n\n" + report, "utf8"),
  });
  if (!result.passed) process.exitCode = 1;
  console.log("ローカルの記録: test/.kinds-local/evidence.md");
} catch (error) {
  // 起動失敗の例外にもURLや資格情報を含めない。
  const reason = error?.code === "EPERM" ? "子プロセスの起動がEPERMで拒否されました。" : "ローカルWorkersの準備を終えられませんでした。";
  writeFileSync(output + "/evidence.md", `# ローカルWorkersの確認\n\n結果: 停止\n日時: ${new Date().toISOString()}\n${reason}\n全段の確認は未完了です。stagingには接続していません。\n`, "utf8");
  console.error("ローカルWorkersの準備: 停止。" + reason + "値は表示しません。");
  process.exitCode = 1;
} finally {
  if (mf) try { await mf.dispose(); } catch {
    console.error("ローカルWorkersの終了処理: 停止。値は表示しません。");
    process.exitCode = 1;
  }
}
