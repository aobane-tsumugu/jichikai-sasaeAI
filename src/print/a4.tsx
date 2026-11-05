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

const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #d9d9d4; }
body { margin: 0; color: #000; font: 12pt/1.7 "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 8px 12px; background: #fff; border-bottom: 1px solid #888; font-size: 14px; }
.toolbar button { font: inherit; min-height: 40px; padding: 4px 18px; border: 1px solid #1f5f8b; border-radius: 6px; background: #1f5f8b; color: #fff; cursor: pointer; }
.toolbar p { margin: 0; color: #333; }
.sheet { width: 210mm; height: 296mm; margin: 8mm auto; padding: 14mm 16mm 10mm; background: #fff; overflow: hidden; display: flex; flex-direction: column; break-after: page; page-break-after: always; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3); }
.sheet:last-of-type { break-after: auto; page-break-after: auto; }
.sheet-body { flex: 1; min-height: 0; }
.sheet.dense { font-size: 10.5pt; line-height: 1.55; }
.sheet.fill .sheet-body { display: flex; flex-direction: column; }
.sheet .field.fill { flex: 1 1 auto; min-height: 0; overflow: hidden; margin-bottom: 2mm; }
.sheet.dense p { margin: 0 0 2mm; }
.sheet .float-qr { float: right; margin: 0 0 3mm 4mm; }
.sheet table { border-collapse: collapse; width: 100%; margin: 0 0 3mm; font-size: 10.5pt; }
.sheet th, .sheet td { border: 0.3mm solid #000; padding: 1mm 2mm; text-align: left; vertical-align: top; }
.sheet-footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; padding-top: 2mm; border-top: 0.3mm solid #000; font-size: 9pt; }
.sheet h1 { margin: 0 0 4mm; font-size: 22pt; line-height: 1.4; }
.sheet h2 { margin: 5mm 0 2mm; font-size: 15pt; line-height: 1.4; }
.sheet p { margin: 0 0 3mm; }
.cut { position: relative; height: 0; margin: 7mm 0; border-top: 0.4mm dashed #000; text-align: center; }
.cut span { position: relative; top: -3.4mm; padding: 0 3mm; background: #fff; font-size: 9pt; }
.qr { display: inline-block; text-align: center; font-size: 8pt; line-height: 1.3; }
.qr svg { display: block; width: 100%; height: auto; }
.qr small { display: block; overflow-wrap: anywhere; }
.field { border: 0.4mm solid #000; padding: 1.5mm 2.5mm; }
.field-code { float: right; font: 8pt/1.2 sans-serif; }
.field-label { font-size: 9pt; }
@page { size: A4 portrait; margin: 0; }
@media print {
  html { background: #fff; }
  .toolbar { display: none; }
  .sheet { margin: 0; box-shadow: none; }
}
@media screen and (max-width: 215mm) {
  .sheet { width: auto; height: auto; min-height: 0; margin: 0 0 6mm; padding: 8mm 5mm; }
  .sheet .field.fill { min-height: 30mm; }
}
`;

const DEFAULT_HINT =
  "「印刷する」を押すと、ブラウザの印刷の画面が開きます。用紙は A4、倍率は 100%、ヘッダーとフッターは外してください。プリンターが無い時は、送り先を「PDF に保存」にしてください。";

/** 印刷用ページの外側。画面の上に印刷ボタンの帯を出す（紙には出ない）。 */
export const PrintDocument: FC<PropsWithChildren<{ title: string; hint?: Child }>> = ({ title, hint, children }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
    </head>
    <body>
      <div class="toolbar">
        <button type="button" onclick="window.print()">
          印刷する
        </button>
        <p>{hint ?? DEFAULT_HINT}</p>
      </div>
      {children}
    </body>
  </html>
);

/** A4 の 1 枚。内容が 1 枚に収まらない時は、枚を分けて書く（溢れた分は紙に出ない）。 */
/** A4 一枚。dense は長い本文を一枚に収めるために文字を少し小さくする。fill は最後の欄が残りの高さを埋める。 */
export const Sheet: FC<PropsWithChildren<{ footer?: Child; dense?: boolean; fill?: boolean }>> = ({ footer, dense, fill, children }) => (
  <section class={["sheet", dense ? "dense" : "", fill ? "fill" : ""].filter(Boolean).join(" ")}>
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
  <div class="field" style={`min-height:${heightMm}mm`}>
    <span class="field-label">{label}</span>{code ? <span class="field-code">{code}</span> : null}
  </div>
);
