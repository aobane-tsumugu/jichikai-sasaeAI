// .env 形式（鍵のファイルと .dev.vars）の読み書き。Node の API を使わない純粋な関数だけ。
// 値は戻り値の中にだけ持ち、エラーや問題の報告には名前と行番号だけを出す（鍵を画面に出さない）。
// 署名鍵は複数行になりうるので、引用符で囲んだ値は行をまたいで読む。

export interface Entry {
  name: string;
  value: string;
}

export interface ParseResult {
  /** 同じ名前が二度出たら後の行が勝つ。順序は最初に出た順。 */
  entries: Entry[];
  /** 読めなかった行の番号（1 始まり）。行の中身は載せない。 */
  badLines: number[];
  /** 二度以上書かれていた名前。 */
  duplicates: string[];
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unescapeDouble(raw: string): string {
  return raw.replace(/\\([nrt"\\])/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return ch;
    }
  });
}

/** text[0] が引用符のとき、閉じる引用符の位置。二重引用符では \ で逃がした引用符を飛ばす。 */
function findClosingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export function parseDotenv(source: string): ParseResult {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = text.split(/\r\n|\n|\r/);
  const order: string[] = [];
  const values = new Map<string, string>();
  const badLines: number[] = [];
  const duplicates = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const body = trimmed.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    const name = eq > 0 ? body.slice(0, eq).trim() : "";
    if (!NAME_PATTERN.test(name)) {
      badLines.push(i + 1);
      continue;
    }

    let rest = body.slice(eq + 1).trim();
    const first = rest[0];
    let value: string;
    if (first === '"' || first === "'") {
      // 閉じる引用符まで、次の行も続けて読む
      let end = findClosingQuote(rest, first);
      let last = i;
      while (end < 0 && last + 1 < lines.length) {
        last++;
        rest += `\n${lines[last] ?? ""}`;
        end = findClosingQuote(rest, first);
      }
      if (end < 0) {
        badLines.push(i + 1);
        continue;
      }
      const inner = rest.slice(1, end);
      value = first === '"' ? unescapeDouble(inner) : inner;
      i = last;
    } else {
      // 引用符なし。空白の後の # から後ろは注釈
      const comment = rest.search(/\s#/);
      value = (comment >= 0 ? rest.slice(0, comment) : rest).trim();
    }

    if (values.has(name)) duplicates.add(name);
    else order.push(name);
    values.set(name, value);
  }

  return {
    entries: order.map((name) => ({ name, value: values.get(name) ?? "" })),
    badLines,
    duplicates: [...duplicates],
  };
}

/** 値が空の項目を分ける。空の項目は渡さない（まだ書かれていない鍵）。 */
export function splitEmpty(entries: Entry[]): { filled: Entry[]; emptyNames: string[] } {
  const filled: Entry[] = [];
  const emptyNames: string[] = [];
  for (const entry of entries) {
    if (entry.value.trim() === "") emptyNames.push(entry.name);
    else filled.push(entry);
  }
  return { filled, emptyNames };
}

const SAFE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** .dev.vars に書く形。特殊な文字（改行を含む）を含む値は二重引用符で囲み、改行は \n で書く。 */
export function formatDotenv(entries: Entry[]): string {
  const lines = entries.map(({ name, value }) => {
    if (SAFE_VALUE.test(value)) return `${name}=${value}`;
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `${name}="${escaped}"`;
  });
  return `${lines.join("\n")}\n`;
}
