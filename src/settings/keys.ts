// 区ごとの設定（ward_settings）のキーと、中身の読み書きの規則。使う束はここの名前で読む。
// 値は文字列で、構造のある物は JSON。

export const SETTING_KEYS = {
  /** 公開用の連絡先（文）。区のページが出す（束 4）。役員個人の連絡先は書かない。 */
  publicContact: "public_contact",
  /** 公式 LINE の友だち追加の URL。公開してよい入口だけを持つ。 */
  officialLineUrl: "official_line_url",
  /** 班の名前（JSON の文字列の配列）。名簿の取り込み（束 5）も書き、区の設定で直す。 */
  squads: "squads",
  /** 定型文（JSON の {id, name, body} の配列）。雨天の変更の知らせなど。 */
  templates: "templates",
  privacyNotice: "privacy_notice",
} as const;

/** 区のページで一律に案内する、利用目的・委託先・消し方。 */
export const PUBLIC_PRIVACY_NOTICE =
  "運営支援は、自治会の行事や連絡、回答の受付のために利用します。提供側が自治会から委託を受けて記録を預かり、文章の読み取りを AI 事業者 Anthropic に委託します。委託と安全管理の根拠は提供側が確認します。消す希望や個人情報の問い合わせは、公開用の連絡先へお知らせください。住民から消す希望が届いたときは、役員が対象を確かめ、原本、読み取った内容、記録を探す索引を一緒に消します。自治会が運営支援を終えるときは、原本、配布した物、記録をお渡しした後、保管物と Anthropic 側の処理を消し、AI の設定を停止して保管庫を削除します。Anthropic API に送った内容は通常、受信・生成から30日以内に削除されます。利用ポリシーへの対応、法令、契約条件により長く保持される場合があります。";

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
