// npm testを使えない作業環境から、同じ道具をローカルのWorkersへ通す。
// node test/run-meeting-local.mjs。ネットワークと永続のD1/R2は使わない。
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMeetingWalkthrough } from "../scripts/walkthrough-meeting.ts";

const output = resolve("test/.meeting-local");
mkdirSync(output, { recursive: true });
writeFileSync(output + "/.gitignore", "*\n", "utf8");
await build({ entryPoints: ["test/meeting-local-worker.ts"], outfile: output + "/worker.mjs", bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*", "node:*"], logLevel: "silent" });
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: output + "/worker.mjs", compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"], r2Buckets: ["ORIGINALS"],
  bindings: { PUBLIC_BASE_URL: "http://localhost", DEMO_NOTICE: "デモ用自治会です。" },
  // 外へは一切接続しない。SDKのfetchは試しの応答に置き換えてある。
  outboundService: () => new Response("ローカル確認では外へ接続しません", { status: 503 }),
}));
try {
  const db = await mf.getD1Database("DB");
  for (const filename of readdirSync("migrations").filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve("migrations", filename), "utf8").replace(/--[^\n]*/g, "").replace(/\r?\n/g, " ");
    await db.exec(sql);
  }
  const response = await mf.dispatchFetch("http://localhost/__meeting_setup", { method: "POST" });
  if (!response.ok) throw new Error("試しの区を準備できません");
  const setup = await response.json();
  const result = await runMeetingWalkthrough({ base: "http://localhost", ...setup }, {
    fetch: (input, init) => mf.dispatchFetch(String(input), init),
    waitMs: 15_000, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 100))),
    log: line => console.log(line),
    record: report => writeFileSync(output + "/evidence.md", "確認環境: ローカルのworkerd。AIの通信は偽物。stagingへの接続なし。\n\n" + report, "utf8"),
  });
  if (!result.passed) process.exitCode = 1;
  console.log("ローカルの記録: test/.meeting-local/evidence.md");
} catch (error) {
  writeFileSync(output + "/evidence.md", `# ローカルWorkersの確認\n\n結果: 停止\n日時: ${new Date().toISOString()}\n理由: ${error instanceof Error ? error.name : "実行エラー"}${error && typeof error === "object" && "code" in error ? " " + String(error.code) : ""}\n全段の確認は未完了です。stagingには接続していません。\n`, "utf8");
  throw error;
} finally {
  await mf.dispose();
}
