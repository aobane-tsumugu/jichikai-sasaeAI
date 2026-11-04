// 区ごとの設定（ward_settings）のキーと、中身の読み書きの規則。使う束はここの名前で読む。
// 値は文字列で、構造のある物は JSON。

export const SETTING_KEYS = {
  /** 公開用の連絡先（文）。区のページが出す（束 4）。役員個人の連絡先は書かない。 */
  publicContact: "public_contact",
  /** 班の名前（JSON の文字列の配列）。名簿の取り込み（束 5）も書き、区の設定で直す。 */
  squads: "squads",
  /** 定型文（JSON の {id, name, body} の配列）。雨天の変更の知らせなど。 */
  templates: "templates",
} as const;

export const LIMITS = {
  publicContact: 500,
  squadCount: 60,
  squadName: 20,
  templateCount: 20,
  templateName: 40,
  templateBody: 2000,
} as const;

export interface Template {
  id: string;
  name: string;
  /** 本文。{会場} のように波括弧で囲んだ言葉は、出す時に中身へ置き換える（renderTemplate）。 */
  body: string;
}

/** 区が定型文を何も保存していない間に出す、標準の定型文。 */
export const DEFAULT_TEMPLATES: readonly Template[] = [
  {
    id: "rain",
    name: "雨天の変更の知らせ",
    body: "【変更のお知らせ】{行事名}は、雨天のため{会場}で行います。日時は{日時}です。くわしくは区のページをご覧ください。",
  },
];

/** {名前} を values の中身に置き換える。values に無い言葉はそのまま残す（後で気づけるように）。 */
export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{([^{}]+)\}/g, (whole, key: string) => values[key.trim()] ?? whole);
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseSquads(value: string | null): string[] {
  const data = parseJson(value);
  return Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
}

/** 保存されていなければ null（標準を使う）。壊れた値も null。 */
export function parseTemplates(value: string | null): Template[] | null {
  const data = parseJson(value);
  if (!Array.isArray(data)) return null;
  const list = data.filter(
    (x): x is Template =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as Template).id === "string" &&
      typeof (x as Template).name === "string" &&
      typeof (x as Template).body === "string",
  );
  return list;
}

/** テキスト欄の「一行に一つ」を、前後の空白を除き、空と重複を除いた配列にする。 */
export function linesToList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const item = line.trim().replace(/\s+/g, " ");
    if (item !== "" && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
