// 画面の共通部品。Workers が HTML を返す（SPA にしない）。スマホで軽く、大きい文字で読めることを優先する。
// 画面に出す言葉は CLAUDE.md の表に従う（派生、差分、版、冪等、札、セッション、包み、列、縁は出さない）。
import type { Child, FC, PropsWithChildren } from "hono/jsx";

const BASE_CSS = `
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fafaf7; --muted: #5d5d57; --line: #d6d6cf; --accent: #1f5f8b; --accent-fg: #fff; --danger: #a12622; --panel: #fff; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececE6; --bg: #181816; --muted: #a8a8a0; --line: #3a3a36; --accent: #7db7e0; --accent-fg: #10222e; --danger: #f08a85; --panel: #22221f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.7 "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, system-ui, sans-serif; }
header.site { border-bottom: 1px solid var(--line); background: var(--panel); }
header.site div, main { max-width: 46rem; margin: 0 auto; padding: 0.75rem 1rem; }
header.site div { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; justify-content: space-between; }
header.site strong { font-size: 1.05rem; }
main { padding-bottom: 3rem; }
h1 { font-size: 1.5rem; margin: 1rem 0 0.75rem; line-height: 1.4; }
h2 { font-size: 1.2rem; margin: 2rem 0 0.5rem; }
a { color: var(--accent); }
p.muted, .muted { color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
label { display: block; font-weight: 600; margin: 0.75rem 0 0.25rem; }
input[type=text], input[type=password], select { width: 100%; font: inherit; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
button, a.button { display: inline-block; font: inherit; min-height: 2.75rem; padding: 0.5rem 1.1rem; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: var(--accent-fg); text-decoration: none; cursor: pointer; }
button.secondary, a.button.secondary { background: transparent; color: var(--accent); }
button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
.notice { border-left: 4px solid var(--accent); padding: 0.5rem 0.75rem; background: var(--panel); margin: 0.75rem 0; }
.notice.error { border-color: var(--danger); }
.secret { font: 1.4rem/1.6 ui-monospace, Consolas, monospace; letter-spacing: 0.05em; word-break: break-all; padding: 0.5rem 0.75rem; border: 2px dashed var(--accent); border-radius: 6px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
form.inline { display: inline; }
.qrbox { width: 12rem; max-width: 100%; margin: 0.5rem 0; }
.qrbox svg { display: block; width: 100%; height: auto; }
`;

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    /** 見出しの左に出す名前（区の名前など）。 */
    siteName?: string;
    /** 見出しの右に出す物（ログイン中の名前、ログアウトなど）。 */
    headerRight?: Child;
    /** 検索に載せない画面（役員画面、運用の画面）。 */
    noindex?: boolean;
  }>
> = ({ title, siteName, headerRight, noindex, children }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {noindex ? <meta name="robots" content="noindex" /> : null}
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: BASE_CSS }} />
    </head>
    <body>
      <header class="site">
        <div>
          <strong>{siteName ?? "運営支援"}</strong>
          <span>{headerRight}</span>
        </div>
      </header>
      <main>{children}</main>
    </body>
  </html>
);

/** 画面の一行の知らせ。 */
export const Notice: FC<PropsWithChildren<{ error?: boolean }>> = ({ error, children }) => (
  <p class={error ? "notice error" : "notice"} role={error ? "alert" : "status"}>
    {children}
  </p>
);
