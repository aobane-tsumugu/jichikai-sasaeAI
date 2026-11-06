// 役員画面の共通の枠。各束の admin の画面はこれで包む（区の名前と最初の画面へのリンクが出る）。
import type { FC, PropsWithChildren } from "hono/jsx";
import type { AccountInfo, WardInfo } from "../env";
import { adminPath } from "./auth";
import { Layout } from "./ui";

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
    {back ? (
      <p>
        <a href={back.href}>{back.label}</a>
      </p>
    ) : null}
    {children}
  </Layout>
);
