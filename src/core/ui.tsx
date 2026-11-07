// 画面の共通部品。Workers が HTML を返す（SPA にしない）。スマホで軽く、大きい文字で読めることを優先する。
// 画面に出す言葉は CLAUDE.md の表に従う（派生、差分、版、冪等、札、セッション、包み、列、縁は出さない）。
import type { Child, FC, PropsWithChildren } from "hono/jsx";

import { BASE_CSS } from "./styles";

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    /** 見出しの左に出す名前（区の名前など）。 */
    siteName?: string;
    /** 役員画面に戻るリンク。 */
    adminHomeHref?: string;
    /** 見出しの右に出す補助のリンク。 */
    headerRight?: Child;
    /** 最初の画面では「最初の画面」のリンクを出さない。 */
    atHome?: boolean;
    /** 検索に載せない画面（役員画面、運用の画面）。 */
    noindex?: boolean;
  }>
> = ({ title, siteName, headerRight, adminHomeHref, atHome, noindex, children }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {noindex ? <meta name="robots" content="noindex" /> : null}
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: BASE_CSS }} />
    </head>
    <body ontouchstart="">
      <header class="site">
        <div>
          <strong>{siteName ?? "SasaeAI"}{adminHomeHref ? " 役員の画面" : ""}</strong>
          <span>{adminHomeHref && !atHome ? <><a href={adminHomeHref}>最初の画面</a>{" "}</> : null}{headerRight}</span>
        </div>
      </header>
      <main>{children}</main>
    </body>
  </html>
);

/** 画面の一行の知らせ。 */
export const Notice: FC<PropsWithChildren<{ error?: boolean }>> = ({ error, children }) => (
  <div class={error ? "notice error" : "notice"} role={error ? "alert" : "status"}>
    {children}
  </div>
);

/** 作ったばかりのパスワードを一度だけ見せる枠。保存は要約だけなので、後から見ることはできない。 */
export const Credentials: FC<{ loginId: string; name: string; password: string }> = ({ loginId, name, password }) => (
  <div class="panel">
    <p>IDとパスワードです。パスワードはこの画面でしか見られません。{name} さんに渡してください。</p>
    <p>
      ID: <strong>{loginId}</strong><br />
      表示名: <strong>{name}</strong>
    </p>
    <p class="secret">{password}</p>
  </div>
);

/** 見出しやボタンに添える説明。押すと開閉でき、JavaScript は要らない。 */
export const Hint: FC<{ text: string }> = ({ text }) => (
  <details class="hint"><summary>説明を読む</summary><div>{text}</div></details>
);

/** URL の符号に対応する、この画面が持つ文だけを出す。 */
export const ErrorNotice: FC<{ code?: string; messages: Readonly<Record<string, string>> }> = ({ code, messages }) => (
  code && Object.prototype.hasOwnProperty.call(messages, code) ? <Notice error>{messages[code]}</Notice> : null
);

/** 入れないときも、区が止まっているときも開ける提供側への道。 */
export const ProviderContact: FC = () => <a class="quiet" href="/contact">SasaeAIに問い合わせる</a>;

export const WardStopped: FC<{ wardName: string; homeHref: string }> = ({ wardName, homeHref }) => (
  <Layout title="役員の画面は止まっています" siteName={`${wardName}役員の画面`} noindex>
    <h1>役員の画面は止まっています</h1>
    <Notice>今は、自治会の役員の画面を使えません</Notice>
    <p>住民向けのページと、知らせた案内は読めます。</p>
    <section class="next"><strong>次は</strong><ProviderContact /></section>
    <a class="quiet" href={homeHref}>住民向けのページを見る</a>
  </Layout>
);
