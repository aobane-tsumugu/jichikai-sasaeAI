// QR の部品。紙に刷る QR の中身と描画。紙と Web を同じ版から出し、撮った紙をプロジェクトと文書と版に決定的に
// 当てるための印（07 設計書 5.3、6.2）。
import { encode, renderSVG } from "uqr";

/** QR の SVG（白地に黒）。幅は呼び出し側の CSS で決める（viewBox だけを持つ）。 */
export function qrSvg(text: string, options: { border?: number } = {}): string {
  // 誤り訂正は M。紙の汚れと折れに耐え、L より読み取りが安定する。静かな領域（border）は 4 モジュール
  return renderSVG(text, { ecc: "M", border: options.border ?? 4 });
}

/** QR のモジュール（true が黒）。試験で読み取りを確かめるために使う。 */
export function qrMatrix(text: string, options: { border?: number } = {}): boolean[][] {
  return encode(text, { ecc: "M", border: options.border ?? 4 }).data;
}

/** 紙の QR が指す物。プロジェクトと文書と版。班ごとに刷る紙は班の名前も付く。 */
export interface PrintCode {
  projectId: string;
  documentId: string;
  /** 版の番号（配った順）。 */
  version: number;
  /** 回答票と班長への一枚の班名（印字する班の名前）。 */
  squad?: string;
}

/** 人が読める紙面の符号。番号は区内の作成順で引く。 */
export interface PaperCode {
  project: number;
  document: number;
  version: number;
}

export function formatPaperCode(code: PaperCode): string {
  return `P${code.project}-D${code.document}-V${code.version}`;
}

export function parsePaperCode(value: string): PaperCode | null {
  const match = /^P([1-9][0-9]*)-D([1-9][0-9]*)-V([1-9][0-9]*)$/i.exec(value.trim());
  if (!match) return null;
  const project = Number(match[1]);
  const document = Number(match[2]);
  const version = Number(match[3]);
  if (![project, document, version].every(Number.isSafeInteger)) return null;
  return { project, document, version };
}

/** 区内の作成順から短い符号を作る。全問い合わせは ward_id で絞る。 */
export async function lookupPaperCode(
  db: D1Database,
  wardId: string,
  value: string,
): Promise<{ projectId: string; documentId: string; version: number } | null> {
  const code = parsePaperCode(value);
  if (!code) return null;
  const projects = await db.prepare("SELECT project_id FROM projects WHERE ward_id = ? ORDER BY created_at, project_id")
    .bind(wardId).all<{ project_id: string }>();
  const project = projects.results[code.project - 1];
  if (!project) return null;
  const documents = await db.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? ORDER BY created_at, document_id")
    .bind(wardId, project.project_id).all<{ document_id: string }>();
  const document = documents.results[code.document - 1];
  if (!document) return null;
  const published = await db.prepare(`SELECT 1 AS found FROM publication_records
    WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_no = ? LIMIT 1`)
    .bind(wardId, project.project_id, document.document_id, code.version).first();
  return published ? { projectId: project.project_id, documentId: document.document_id, version: code.version } : null;
}

/** 読み取った QR がこの区で実際に配った物か確認してから返す。 */
export async function lookupPrintQr(
  db: D1Database,
  wardId: string,
  wardSlug: string,
  text: string,
): Promise<PrintCode | null> {
  const parsed = parsePrintQrUrl(text);
  if (!parsed || parsed.wardSlug !== wardSlug) return null;
  const code = parsed.code;
  const row = await db.prepare(`SELECT 1 AS found FROM publication_records
    WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_no = ? LIMIT 1`)
    .bind(wardId, code.projectId, code.documentId, code.version).first();
  return row ? code : null;
}

export async function makePaperCode(
  db: D1Database,
  wardId: string,
  projectId: string,
  documentId: string,
  version: number,
): Promise<string | null> {
  const projects = await db.prepare("SELECT project_id FROM projects WHERE ward_id = ? ORDER BY created_at, project_id")
    .bind(wardId).all<{ project_id: string }>();
  const projectIndex = projects.results.findIndex((row) => row.project_id === projectId);
  if (projectIndex < 0) return null;
  const documents = await db.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? ORDER BY created_at, document_id")
    .bind(wardId, projectId).all<{ document_id: string }>();
  const documentIndex = documents.results.findIndex((row) => row.document_id === documentId);
  if (documentIndex < 0) return null;
  return formatPaperCode({ project: projectIndex + 1, document: documentIndex + 1, version });
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 紙の QR に入れる URL: <根>/<区のスラッグ>/q/<プロジェクト>/<文書>/<版>[?s=<班>]
 * 区のページと同じドメインの下で、スマホが読むとそのままブラウザが開く。この URL を開いた時に出す
 * ページは、区のページ（束 4）が /:ward/q/** で受ける。撮った紙の当ては parsePrintQrUrl で行う。
 */
export function printQrUrl(baseUrl: string, wardSlug: string, code: PrintCode): string {
  if (!ID_PATTERN.test(code.projectId) || !ID_PATTERN.test(code.documentId)) {
    throw new Error("プロジェクトと文書の識別子は英数字、_、- だけにしてください。");
  }
  if (!Number.isInteger(code.version) || code.version < 1) {
    throw new Error("版は 1 以上の整数にしてください。");
  }
  const base = `${baseUrl.replace(/\/+$/, "")}/${wardSlug}/q/${code.projectId}/${code.documentId}/${code.version}`;
  return code.squad ? `${base}?s=${encodeURIComponent(code.squad)}` : base;
}

/** QR から読み取った URL を PrintCode に戻す。この形でなければ null。 */
export function parsePrintQrUrl(text: string): { wardSlug: string; code: PrintCode } | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const match = /^\/([a-z0-9-]+)\/q\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (!match) return null;
  const [, wardSlug, projectId, documentId, version] = match;
  const squad = url.searchParams.get("s") ?? undefined;
  return {
    wardSlug: wardSlug!,
    code: { projectId: projectId!, documentId: documentId!, version: Number(version), ...(squad ? { squad } : {}) },
  };
}
