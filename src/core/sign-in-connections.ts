import type { Context } from "hono";
import type { AdminEnv, Env, WardEnv } from "../env";

export type ExternalSignInKind = "line" | "email";
export type SignInIntent = { invitation: string } | { accountId: string } | { login: true };
export type VerifiedSignIn = {
  identity: { kind: "line"; subject: string } | { kind: "email"; email: string };
  intent: SignInIntent;
};

/**
 * 送信とLINE Loginの接続口。送信設定がそろうまでは渡さず、選択肢も出さない。
 * startは本人確認の開始、finishは確認済みの結果だけを返す。
 * 接続側がstateと端末の対応、有効期間、一度限りの使用を確かめる。
 * メールは確認用リンクを30分にし、送信画面では登録の有無を答えない。
 * 招待の本体は確認が終わるまで使わない。途中でやめた場合は同じ招待へ戻す。
 * 送信先や相手のIDをフォームからそのまま確認済みとして返してはいけない。
 */
export interface SignInConnection {
  start(c: Context<WardEnv> | Context<AdminEnv>, intent: SignInIntent): Promise<Response>;
  finish(c: Context<WardEnv>): Promise<VerifiedSignIn | { cancelled: true; intent: SignInIntent } | null>;
}

export interface SignInConnections {
  line?: SignInConnection;
  email?: SignInConnection;
}

/** Worker内で組み立てた接続を受ける。外から来たJSONやWorkers secretの文字列は接続にならない。 */
export function signInConnections(env: Env): SignInConnections {
  const connected = (env as Env & { SIGN_IN_CONNECTIONS?: SignInConnections }).SIGN_IN_CONNECTIONS;
  return connected ?? {};
}
