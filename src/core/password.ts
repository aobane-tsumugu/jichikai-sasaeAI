// パスワードと札の部品。Web Crypto だけを使う（Workers でも Node 24 でも動く）。
//
// 役員のパスワードは Workers が作る長い乱数（約 119 ビット）で、人が決めた弱い文字列ではない。
// なので遅い要約（PBKDF2 など）は要らず、塩付きの SHA-256 で足りる。遅い要約は Workers の
// CPU 時間の上限（無料枠は 10 ms）を使い切る。

// 読み間違えやすい i, l, o, 0, 1 を除いた 31 文字。スマホで打つ物なので小文字と数字だけにする。
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 6;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return toHex(new Uint8Array(digest));
}

/** 偏りなく乱数の文字を選ぶ（256 を 31 で割った余りの範囲は捨てる）。 */
function randomChars(length: number): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

/** 表示用のパスワード。例 abcdef-ghjkmn-pqrstu-vwxyz2。一度だけ見せ、保存は要約だけ。 */
export function generatePassword(): string {
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) groups.push(randomChars(GROUP_LENGTH));
  return groups.join("-");
}

/** 打ち間違いに寛容にする。全角、大文字、ハイフン、空白の違いは同じ物として扱う。 */
export function normalizePassword(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/[\s-]/g, "");
}

export function generateSalt(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${normalizePassword(password)}`);
}

/** 長さが同じ二つの文字列を、時間差で漏らさずに比べる。 */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  return safeEqual(await hashPassword(password, salt), expectedHash);
}

/** 端末の記憶に使う札（Cookie の中身）。要約だけを D1 に置く。 */
export function generateDeviceToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 名前の表示用。前後の空白を削り、続く空白（全角を含む）を一つにする。文字の形は変えない。 */
export function cleanName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/** 名前の照合用。全角と半角を揃え、空白を全部除き、小文字にする（「山田 太郎」と「山田太郎」を同じ物にする）。 */
export function nameKey(input: string): string {
  return cleanName(input).normalize("NFKC").toLowerCase().replace(/\s/g, "");
}

/** ログイン ID は前後の空白を除き、半角英数字だけを受け付ける。 */
export function cleanLoginId(input: string): string {
  return input.trim().toLowerCase();
}

export function loginIdProblem(input: string): string | null {
  const id = cleanLoginId(input);
  if (id === "") return "ID を入れてください。";
  if (id.length > 40) return "ID は 40 文字までです。";
  if (!/^[A-Za-z0-9]+$/.test(id)) return "ID は半角の英数字だけで入力してください。";
  return null;
}
