// 鍵のファイルからローカルの .dev.vars を作る（wrangler dev と試験が読む。git に入らない）。
//
//   npm run dev-vars -- --keys <鍵のファイルのパス>
//   （または環境変数 JICHIKAI_KEYS_FILE にパスを入れておく）
//
// 鍵のファイルの全部の行を読み、値が空の行は飛ばして書く。鍵の値は表示しない。
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDotenv } from "./lib/dotenv.ts";
import {
  argValue,
  listNames,
  loadKeyFile,
  reportWarnings,
  resolveKeyFilePath,
} from "./lib/keyfile.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

try {
  const keys = loadKeyFile(resolveKeyFilePath(argv, process.env));
  if (keys.filled.length === 0) {
    throw new Error("鍵のファイルに値の入った行がありません。書いてから、もう一度実行してください。");
  }

  const out = resolve(argValue(argv, "--out") ?? resolve(root, ".dev.vars"));

  // 誤って git に入れないよう、出力先が無視の対象でなければ止める（git が無い、リポジトリの外なら進む）
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", out], { cwd: root });
  if (ignored.status === 1) {
    throw new Error(`${out} は git の無視の対象ではないので書きません。.gitignore を確かめてください。`);
  }

  writeFileSync(out, formatDotenv(keys.filled), { encoding: "utf8", mode: 0o600 });
  console.log(`${out} に ${keys.filled.length} 件を書きました: ${listNames(keys.filled.map((e) => e.name))}`);
  reportWarnings(keys);
} catch (error) {
  console.error(error instanceof Error ? error.message : "失敗しました");
  process.exitCode = 1;
}
