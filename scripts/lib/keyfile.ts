// 鍵のファイル（リポジトリの外。本人が書く .env 形式）を読む部品。Node 用。
// 鍵の値は画面にもログにも出さない。出すのは名前と件数だけ。
import { readFileSync } from "node:fs";
import { splitEmpty, parseDotenv, type Entry } from "./dotenv.ts";

/** 鍵のファイルの場所を渡す環境変数。パスはリポジトリに書かず、引数かこれで渡す。 */
export const KEY_FILE_ENV = "JICHIKAI_KEYS_FILE";

/** src/env.ts に宣言した鍵の名前。env.ts を変えたらここも合わせる（宣言に無い名前は警告するだけで、渡しは止めない）。 */
export const DECLARED_KEYS: readonly string[] = [
  "ANTHROPIC_FEDERATION_SIGNING_KEY",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_WEBHOOK_SIGNING_KEY",
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "OPS_ID",
  "OPS_PASSWORD",
];

/** --flag 値 または --flag=値 を取り出す。 */
export function argValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function resolveKeyFilePath(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string {
  const path = argValue(argv, "--keys") ?? env[KEY_FILE_ENV];
  if (!path) {
    throw new Error(
      `鍵のファイルの場所がありません。--keys <パス> を付けるか、環境変数 ${KEY_FILE_ENV} に入れてください。`,
    );
  }
  return path;
}

export interface LoadedKeys {
  /** 値の入っている項目。渡すのはこれだけ。 */
  filled: Entry[];
  /** 値が空だった名前（まだ書かれていない鍵）。 */
  emptyNames: string[];
  duplicates: string[];
  /** src/env.ts に宣言の無い名前。 */
  undeclaredNames: string[];
}

export function loadKeyFile(path: string): LoadedKeys {
  let source: string;
  try {
    source = readFileSync(path, { encoding: "utf8" });
  } catch {
    throw new Error(`鍵のファイルを読めませんでした: ${path}`);
  }
  const parsed = parseDotenv(source);
  if (parsed.badLines.length > 0) {
    throw new Error(
      `鍵のファイルに読めない行があります（行 ${parsed.badLines.join(", ")}）。NAME=値 の形にしてください。`,
    );
  }
  const { filled, emptyNames } = splitEmpty(parsed.entries);
  return {
    filled,
    emptyNames,
    duplicates: parsed.duplicates,
    undeclaredNames: filled.map((e) => e.name).filter((n) => !DECLARED_KEYS.includes(n)),
  };
}

/** 名前の一覧を一行にする。値は含めない。 */
export function listNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "なし";
}

export function reportWarnings(keys: LoadedKeys): void {
  if (keys.emptyNames.length > 0) {
    console.log(`値が空なので渡さない名前: ${listNames(keys.emptyNames)}`);
  }
  if (keys.duplicates.length > 0) {
    console.log(`二度書かれていた名前（後の行を使う）: ${listNames(keys.duplicates)}`);
  }
  if (keys.undeclaredNames.length > 0) {
    console.log(`src/env.ts に宣言の無い名前（そのまま渡す）: ${listNames(keys.undeclaredNames)}`);
  }
}
