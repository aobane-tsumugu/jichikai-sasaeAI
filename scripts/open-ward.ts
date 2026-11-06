// 区の開設（提供側）: 区、最初の役員のアカウント、固定 URL と QR を作る。
//
//   npm run open-ward -- --name "区の名前" --slug <区の URL> --first "最初の役員の名前" --line-destination <公式LINEの送信先ID> --official-line-url <友だち追加のURL> \
//       [--base <運用の画面の URL>] [--keys <鍵のファイルのパス>] [--qr-out <QR を書く .svg>] \
//       [--credentials-out <名前と入るためのリンクを書くファイル>]
//
// 運用の画面（/ops）に OPS_ID と OPS_PASSWORD でログインして、POST /ops/wards を呼ぶ。
// OPS_ID と OPS_PASSWORD は鍵のファイル（--keys か環境変数 JICHIKAI_KEYS_FILE）から読み、表示しない。
// --base の既定は wrangler.toml の PUBLIC_BASE_URL。ローカルなら --base http://localhost:8787。
// 最初の役員の入るためのリンクはここで一度だけ見える。--credentials-out を付けるとファイルに書き、画面には出さない。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue, loadKeyFile, resolveKeyFilePath } from "./lib/keyfile.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function required(flag: string): string {
  const value = argValue(argv, flag);
  if (!value) throw new Error(`${flag} が必要です。`);
  return value;
}

function defaultBase(): string {
  const toml = readFileSync(resolve(root, "wrangler.toml"), { encoding: "utf8" });
  const match = /^PUBLIC_BASE_URL\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match?.[1]) throw new Error("--base がなく、wrangler.toml にも PUBLIC_BASE_URL がありません。");
  return match[1];
}

interface OpenedWard {
  ok: true;
  slug: string;
  name: string;
  url: string;
  adminUrl: string;
  qrSvgUrl: string;
  account: { loginId: string; name: string; invitationUrl: string; expiresAt: string };
}

async function main(): Promise<void> {
  const name = required("--name");
  const slug = required("--slug");
  const first = required("--first");
  const lineDestination = required("--line-destination");
  const officialLineUrl = required("--official-line-url");
  const base = (argValue(argv, "--base") ?? defaultBase()).replace(/\/+$/, "");
  const origin = new URL(base).origin;

  const keys = loadKeyFile(resolveKeyFilePath(argv, process.env));
  const opsId = keys.filled.find((e) => e.name === "OPS_ID")?.value;
  const opsPassword = keys.filled.find((e) => e.name === "OPS_PASSWORD")?.value;
  if (!opsId || !opsPassword) throw new Error("鍵のファイルに OPS_ID と OPS_PASSWORD がありません。");

  const timeout = () => AbortSignal.timeout(30_000);

  // 運用の画面にログインして、札（Cookie）を受け取る
  const login = await fetch(`${base}/ops/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ id: opsId, password: opsPassword }),
    signal: timeout(),
  });
  const session = login.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.startsWith("ops_session="));
  if (login.status !== 303 || !session) {
    throw new Error(
      login.status === 401
        ? "運用の画面にログインできませんでした（ID かパスワードが違います）。"
        : login.status === 503
          ? "運用の画面が設定されていません（Workers の secrets に OPS_ID と OPS_PASSWORD を入れてください）。"
          : `運用の画面にログインできませんでした（${login.status}）。`,
    );
  }

  const response = await fetch(`${base}/ops/wards`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      origin,
      cookie: session,
    },
    body: new URLSearchParams({ name, slug, firstAccountName: first, lineDestination, officialLineUrl }),
    signal: timeout(),
  });
  const body = (await response.json().catch(() => null)) as OpenedWard | { ok: false; message: string } | null;
  if (!body || !body.ok) {
    throw new Error(`区を開けませんでした: ${body && "message" in body ? body.message : response.status}`);
  }

  console.log(`区を開きました: ${body.name}`);
  console.log(`  区のページ: ${body.url}`);
  console.log(`  役員画面:   ${body.adminUrl}`);
  console.log(`  最初の役員 ID: ${body.account.loginId}`);
  console.log(`  表示名: ${body.account.name}`);

  const credentialsOut = argValue(argv, "--credentials-out");
  if (credentialsOut) {
    writeFileSync(credentialsOut, `ID: ${body.account.loginId}\n表示名: ${body.account.name}\n入るためのリンク: ${body.account.invitationUrl}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`  入るためのリンク: ${credentialsOut} に書きました（役員に渡したら消してください）`);
  } else {
    console.log(`  入るためのリンク: ${body.account.invitationUrl}  （一度だけの表示です。役員に渡してください）`);
  }

  const qrOut = argValue(argv, "--qr-out");
  if (qrOut) {
    const qr = await fetch(`${base}/ops/wards/${body.slug}/qr.svg`, { headers: { cookie: session }, signal: timeout() });
    if (!qr.ok) throw new Error(`QR を取れませんでした（${qr.status}）。運用の画面から開いてください。`);
    writeFileSync(qrOut, await qr.text(), { encoding: "utf8" });
    console.log(`  QR: ${qrOut}`);
  }
  console.log(`  A4 の案内（印刷）: ${base}/ops/wards/${body.slug}/sheet`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "失敗しました");
  process.exitCode = 1;
});
