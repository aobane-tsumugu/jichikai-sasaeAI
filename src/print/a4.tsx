// 印刷用ページの共通部品（A4 の版面）。ブラウザの印刷で紙か PDF にする。PDF は作らない（L-131）。
// 中身（案内、回答票、班長への一枚、当番表、記入欄）は束 4 の src/print/pages/ がこの部品で組む。
//
// 使い方:
//   c.html(
//     <PrintDocument title="収穫祭のご案内">
//       <Sheet footer={<span>{ward.name}</span>}>...</Sheet>
//       <Sheet>...<CutLine />...<PrintQr text={url} caption={url} /></Sheet>
//     </PrintDocument>,
//   )
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { qrSvg } from "./qr";

import { BASE_CSS, PRINT_CSS } from "../core/styles";


const DEFAULT_HINT =
  "「印刷する」を押すと、ブラウザの印刷の画面が開きます。用紙は A4、倍率は 100%、ヘッダーとフッターは外してください。プリンターが無い時は、送り先を「PDF に保存」にしてください。";

/** 印刷用ページの外側。画面の上に印刷ボタンの帯を出す（紙には出ない）。 */
export const PrintDocument: FC<PropsWithChildren<{ title: string; hint?: Child; back?: string; copies?: string }>> = ({ title, hint, back, copies, children }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: BASE_CSS + PRINT_CSS }} />
    </head>
    <body>
      <div class="toolbar">
        {back ? <a href={back}>戻る</a> : null}
        <button type="button" onclick="window.print()">
          印刷する
        </button>
        <p>{hint ?? DEFAULT_HINT}</p>
        {copies ? <p>配る部数　{copies}</p> : null}
      </div>
      {children}
    </body>
  </html>
);

/** A4 の印刷範囲。長い本文や表はブラウザが次の頁へ続け、表の見出しを繰り返す。 */
export const Sheet: FC<PropsWithChildren<{ footer?: Child }>> = ({ footer, children }) => (
  <section class="sheet">
    <div class="sheet-body">{children}</div>
    {footer ? <div class="sheet-footer">{footer}</div> : null}
  </section>
);

/** 切り取り線（回答票の上など）。 */
export const CutLine: FC<{ label?: string }> = ({ label }) => (
  <div class="cut" role="separator">
    <span>{label ?? "ここで切り取る"}</span>
  </div>
);

/**
 * QR。sizeMm の正方形（静かな領域を含む）。URL が読めない時のために caption に同じ URL を添えるとよい。
 * 印刷しても読めるよう、白地に黒で、色を変えない。
 */
export const PrintQr: FC<{ text: string; sizeMm?: number; caption?: string }> = ({ text, sizeMm = 32, caption }) => (
  <div class="qr" style={`width:${sizeMm}mm`}>
    <div dangerouslySetInnerHTML={{ __html: qrSvg(text) }} />
    {caption ? <small>{caption}</small> : null}
  </div>
);

/** 手で書き込む欄（枠と見出し）。高さは mm。 */
export const FieldBox: FC<{ label: string; heightMm?: number; code?: string }> = ({ label, heightMm = 12, code }) => (
  <div class="field-box" style={`min-height:${heightMm}mm`}>
    <span class="field-label">{label}</span>{code ? <span class="field-code">紙の番号: {code}</span> : null}
  </div>
);
