// 役員画面の共通の枠。各束の admin の画面はこれで包む（区の名前と最初の画面へのリンクが出る）。
import type { FC, PropsWithChildren } from "hono/jsx";
import type { Context } from "hono";
import type { AccountInfo, AdminEnv, WardInfo } from "../env";
import { adminPath } from "./auth";
import { Layout, Notice } from "./ui";

export const AdminPage: FC<
  PropsWithChildren<{
    ward: WardInfo;
    account: AccountInfo;
    title: string;
    /** 上に出す「戻る」のリンク。 */
    back?: { href: string; label: string };
  }>
> = ({ ward, account, title, back, children }) => (
  <Layout
    title={`${title} ${ward.name}`}
    siteName={ward.name}
    adminHomeHref={adminPath(ward, "/")}
    headerRight={<span>{account.name} さん</span>}
    noindex
  >
    {back ? <a class="back" href={back.href}>{back.label.startsWith("←") ? back.label : `← ${back.label}`}</a> : null}
    {children}
  </Layout>
);

/** 文字だけの応答にせず、起きたことと次にできることを伝える。 */
export function adminResult(
  c: Context<AdminEnv>,
  message: string,
  status: 200 | 400 | 409 | 500,
  back: { href: string; label: string },
  next: string,
) {
  const title = status < 400 ? "受け付けました" : "操作を終えられませんでした";
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title={title}>
    <h1>{title}</h1><Notice error={status >= 400}>{message}</Notice>
    <section class="next"><strong>次は</strong><p>{next}</p><a class="button secondary" href={back.href}>{back.label}</a></section>
    {status >= 400 ? <p>入力した内容を直すときは、ブラウザの戻るボタンで戻れます。</p> : null}
  </AdminPage>, status);
}
