// Workers の束縛、鍵、Hono の文脈の型。束 1 の持ち物で、他の束は触らない。
// 足りない束縛や鍵があれば PM に言う。

/** Workers が渡す束縛と鍵。鍵の値は Workers の secrets（ローカルは .dev.vars）にだけ置く。 */
export interface Env {
  /** D1。全ての表は ward_id を持つ。 */
  DB: D1Database;
  /** 提供側の顔処理。未配備では区の設定を有効にしない。 */
  FACE_MASK?: DurableObjectNamespace;
  /** R2。原本、出した物、写し。キーは src/core/storage.ts の WardBucket 越しに作る。 */
  ORIGINALS: R2Bucket;
  /** 元の資料と日次の写しを別に保管する。接続していなければ複写しない。 */
  ORIGINALS_BACKUP?: R2Bucket;

  /** 区のページの固定 URL の根。空なら要求の origin。 */
  PUBLIC_BASE_URL: string;
  /** デモの環境だけに置く、架空であることの断り。本番では置かない。 */
  DEMO_NOTICE?: string;

  // 束 2: Anthropic。API キーは使わず、署名鍵でトークンに交換する（実装は src/ai/）。ブラウザへは渡さない。
  ANTHROPIC_FEDERATION_SIGNING_KEY: string;
  ANTHROPIC_FEDERATION_RULE_ID: string;
  ANTHROPIC_ORGANIZATION_ID: string;
  ANTHROPIC_SERVICE_ACCOUNT_ID: string;
  ANTHROPIC_WORKSPACE_ID: string;
  ANTHROPIC_WEBHOOK_SIGNING_KEY: string;
  // 束 6: LINE。
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** 区ごとの LINE の鍵。D1 に置くのは、この Workers secret の名前だけ。 */
  [name: `LINE_${string}`]: string | undefined;

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
