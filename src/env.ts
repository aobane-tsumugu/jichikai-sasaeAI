// Workers の束縛、鍵、Hono の文脈の型。束 1 の持ち物で、他の束は触らない。
// 足りない束縛や鍵があれば PM に言う。

/** Workers が渡す束縛と鍵。鍵の値は Workers の secrets（ローカルは .dev.vars）にだけ置く。 */
export interface Env {
  /** D1。全ての表は ward_id を持つ。 */
  DB: D1Database;
  /** R2。原本、出した物、写し。キーは src/core/storage.ts の WardBucket 越しに作る。 */
  ORIGINALS: R2Bucket;

  /** 区のページの固定 URL の根。空なら要求の origin。 */
  PUBLIC_BASE_URL: string;

  // 束 2: Anthropic。ブラウザへは渡さない。
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_WEBHOOK_SIGNING_KEY: string;
  // 束 6: LINE。
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;

  // 運用の画面（提供側）。未設定なら運用の画面は開かない。
  OPS_ID?: string;
  OPS_PASSWORD?: string;
}

/** 区の情報。要求の URL の区のスラッグから決まる。 */
export interface WardInfo {
  wardId: string;
  slug: string;
  name: string;
}

/** ログイン済みの役員のアカウント。席は名札であって、鍵ではない。 */
export interface AccountInfo {
  accountId: string;
  name: string;
  seatId: string | null;
}

/** 区をまたぐ入口（/hooks/**、/ops/**）。 */
export type AppEnv = { Bindings: Env };

/** 区の中の入口（/:ward/**）。c.var.ward が入っている。ログインは要らない。 */
export type WardEnv = { Bindings: Env; Variables: { ward: WardInfo } };

/** 役員画面（/:ward/admin/**）。c.var.ward と c.var.account が入っている。 */
export type AdminEnv = {
  Bindings: Env;
  Variables: { ward: WardInfo; account: AccountInfo; deviceId: string };
};

type WorkerBindings = Env;

declare global {
  // cloudflare:workers の env（と試験の env）の型
  namespace Cloudflare {
    interface Env extends WorkerBindings {}
  }
}
