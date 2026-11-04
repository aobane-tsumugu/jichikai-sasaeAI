import type { Hono } from "hono";
import type { AdminEnv, AppEnv, Env, WardEnv } from "../env";

/**
 * 各置き場（束）が束 1 の index.ts へ差し込む口の約束。
 *
 * 各置き場の index.ts は、この形の物を一つだけ export する。src/index.ts がそれを読み込むので、
 * 束 2 以降は src/index.ts と src/env.ts を触らずに、自分の置き場の中だけで経路を足せる。
 *
 * 口は三つと Cron。
 *
 * - admin: /:ward/admin/** に付く。ログイン必須。c.var.ward と c.var.account が入る。
 *          「役の名札」では分けない。ログインしていれば役員の誰でも使える（前提 11）。
 * - pub:   /:ward/** に付く。ログイン不要。c.var.ward が入る。区のページ、回答の入口、プロジェクトの空間、
 *          MCP の口のように、自前の鍵（合言葉、札、トークン）で守る物もここ。/:ward/admin/** は書けない。
 * - hooks: /hooks/** に付く。区をまたぐ機械向けの受け口（webhook）。ward は URL に無いので、
 *          中身（メタデータ、チャネル）から自分で決める。署名の検査は各自。
 * - scheduled: Cron。src/core/cron.ts の式と event.cron を比べて、自分の仕事だけをする。
 *              他の置き場の仕事を止めないよう、投げた例外は index.ts が置き場名付きで記録して続行する。
 *
 * 経路の取り決め。同じ口の中で、置き場をまたいで同じ（メソッド, パス）を持たない。
 * test/bundles.test.ts がそれを検査するので、重なったら npm test が落ちる。
 * 目安の接頭辞（強制ではない。重ならなければ変えてよい）:
 *
 *   置き場           admin の接頭辞          pub の接頭辞      hooks
 *   settings (1)     /settings /login       -                -
 *   intake (2)       /intake                -                -
 *   ai (2)           -                      /mcp             /anthropic
 *   project (3)      /projects              -                -
 *   map (3)          /projects/:id/map      -                -
 *   draft (3)        /projects/:id/draft    -                -
 *   check (3)        /projects/:id/check    -                -
 *   publish (4)      /publish               -                -
 *   ward (4)         -                      / /p /q          -
 *   print/pages (4)  /print                 -                -
 *   answers (5)      /answers               /answer          -
 *   space (5)        /space                 /space           -
 *   line (6)         /inbox                 -                /line
 *   close (7)        /close                 -                -
 *   archive (7)      /archive               -                -
 *
 * 守ること。
 * - D1 の問い合わせは、必ず c.var.ward.wardId を where に入れる。URL や本文に来た ward_id は信じない。
 * - R2 のキーは WardBucket（src/core/storage.ts）越しに作る。
 * - 表を足す時は migrations/NN01_*.sql（束 N）。他の区を指さないよう、(ward_id, 〇〇_id) の複合外部キーを使う。
 *   既に配った migration の中身は書き換えず、足す時は次の番号のファイルを作る。
 */
export interface Bundle {
  admin?: Hono<AdminEnv>;
  pub?: Hono<WardEnv>;
  hooks?: Hono<AppEnv>;
  scheduled?: (event: ScheduledController, env: Env, ctx: ExecutionContext) => Promise<void>;
}
