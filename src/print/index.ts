// 束 1: 印刷用ページの骨。A4 の版面の共通部品と QR の部品。
// ページの中身（案内、回答票、班長への一枚、当番表と配置図、記入欄）は束 4 の src/print/pages/ にある。
export { CutLine, FieldBox, PrintDocument, PrintQr, Sheet } from "./a4";
export { parsePrintQrUrl, printQrUrl, qrMatrix, qrSvg } from "./qr";
export type { PrintCode } from "./qr";
