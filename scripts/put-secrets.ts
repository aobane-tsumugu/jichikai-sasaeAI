// 鍵のファイルの内容を Workers の secrets に入れる（wrangler secret bulk）。
//
//   npm run put-secrets -- --keys <鍵のファイルのパス> [--dry-run] [--name <Worker 名>]
//   （または環境変数 JICHIKAI_KEYS_FILE にパスを入れておく）
//
// 鍵のファイルの全部の行を読み、値が空の行は飛ばして渡す。鍵の値は表示せず、標準入力で
// wrangler に渡す（一時ファイルも作らない）。--dry-run は名前を示すだけで何も送らない。
// 送り先は wrangler.toml の Worker（既定は staging）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  argValue,
  hasFlag,
  listNames,
  loadKeyFile,
  reportWarnings,
  resolveKeyFilePath,
} from "./lib/keyfile.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function configuredWorkerName(): string {
  const toml = readFileSync(resolve(root, "wrangler.toml"), { encoding: "utf8" });
  const match = /^name\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match?.[1]) throw new Error("wrangler.toml に Worker の name がありません。");
  return match[1];
}

try {
  const keys = loadKeyFile(resolveKeyFilePath(argv, process.env));
  if (keys.filled.length === 0) {
    throw new Error("鍵のファイルに値の入った行がありません。書いてから、もう一度実行してください。");
  }

  const name = argValue(argv, "--name") ?? configuredWorkerName();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Worker 名は小文字の英数字とハイフンだけです。");

  const names = keys.filled.map((e) => e.name);
  reportWarnings(keys);

  if (hasFlag(argv, "--dry-run")) {
    console.log(`[dry-run] ${name} の secrets に入れる ${names.length} 件: ${listNames(names)}`);
  } else {
    const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
    if (!existsSync(wrangler)) throw new Error("wrangler がありません。npm install を先に実行してください。");

    console.log(`${name} の secrets に ${names.length} 件を入れます: ${listNames(names)}`);
    const body = JSON.stringify(Object.fromEntries(keys.filled.map((e) => [e.name, e.value])));
    const result = spawnSync(process.execPath, [wrangler, "secret", "bulk", "--name", name], {
      cwd: root,
      input: body,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (result.status !== 0) throw new Error("wrangler secret bulk が失敗しました。");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "失敗しました");
  process.exitCode = 1;
}
