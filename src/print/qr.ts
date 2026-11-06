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
  const match = /^P([1-9][0-9]*)-D(0|[1-9][0-9]*)-V([1-9][0-9]*)$/i.exec(value.trim());
  if (!match) return null;
  const project = Number(match[1]);
  const document = Number(match[2]);
  const version = Number(match[3]);
  if (![project, document, version].every(Number.isSafeInteger)) return null;
  return { project, document, version };
}

/** 保存した番号から紙の指す先を引く。消した行事や文書の番号は使い直さない。 */
export async function lookupPaperCode(
  db: D1Database,
  wardId: string,
  value: string,
): Promise<{ projectId: string; documentId: string; version: number } | null> {
  const code = parsePaperCode(value);
  if (!code) return null;
  const project = await db.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND paper_no = ?")
    .bind(wardId, code.project).first<{ project_id: string }>();
  if (!project) return null;
  // D0 は文書を配る前の記入用紙。文書を作らず、プロジェクトだけへ戻す。
  if (code.document === 0) return code.version === 1 ? { projectId: project.project_id, documentId: "_project", version: 1 } : null;
  const document = await db.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? AND paper_no = ?")
    .bind(wardId, project.project_id, code.document).first<{ document_id: string }>();
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
  if (code.documentId === "_project") {
    const project = await db.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, code.projectId).first();
    return project ? code : null;
  }
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
  const project = await db.prepare("SELECT paper_no FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<{ paper_no: number }>();
  if (!project) return null;
  const document = await db.prepare("SELECT paper_no FROM documents WHERE ward_id = ? AND project_id = ? AND document_id = ?")
    .bind(wardId, projectId, documentId).first<{ paper_no: number }>();
  if (!document) return null;
  return formatPaperCode({ project: project.paper_no, document: document.paper_no, version });
}

/** 配る前の紙。D0 は記入用紙のために予約し、既存の読み取り経路でプロジェクトへ当てる。 */
export async function makeProjectPaperCode(db: D1Database, wardId: string, projectId: string): Promise<string | null> {
  const project = await db.prepare("SELECT paper_no FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<{ paper_no: number }>();
  return project ? formatPaperCode({ project: project.paper_no, document: 0, version: 1 }) : null;
}

/** 記入用紙の QR は役員の紙の入口へ戻す。公開の案内や班長の鍵は含めない。 */
export function projectPaperQrUrl(baseUrl: string, wardSlug: string, projectId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(wardSlug)}/admin/print/${encodeURIComponent(projectId)}`;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 紙の QR に入れる URL: <根>/<区のスラッグ>/q/<プロジェクト>/<文書>/<版>[?s=<班>]
 * 区のページと同じドメインの下で、スマホが読むとそのままブラウザが開く。この URL を開いた時に出す
 * ページは、区のページ（束 4）が /:ward/q/** で受ける。撮った紙の当ては parsePrintQrUrl で行う。
 */
export function printQrUrl(baseUrl: string, wardSlug: string, code: PrintCode): string {
  if (!ID_PATTERN.test(code.projectId) || !ID_PATTERN.test(code.documentId)) {
    throw new Error("行事と文書の識別子は英数字、_、- だけにしてください。");
  }
  if (!Number.isInteger(code.version) || code.version < 1) {
    throw new Error("版は1以上の整数にしてください。");
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
  const paper = /^\/([a-z0-9-]+)\/admin\/print\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (paper) return { wardSlug: paper[1]!, code: { projectId: paper[2]!, documentId: "_project", version: 1 } };
  const match = /^\/([a-z0-9-]+)\/q\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (!match) return null;
  const [, wardSlug, projectId, documentId, version] = match;
  const squad = url.searchParams.get("s") ?? undefined;
  return {
    wardSlug: wardSlug!,
    code: { projectId: projectId!, documentId: documentId!, version: Number(version), ...(squad ? { squad } : {}) },
  };
}
