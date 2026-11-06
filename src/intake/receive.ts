// 受付。送られた物を検査し、ハッシュで同じ物を弾き、原本を R2 に置き、入った物（jobs）と原本の行を作る。
// 読むのは別（pipeline.ts）。ここは受けるところまでで、速く返す。
import { newId, nowIso } from "../core/ids";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";
import { READ_PACK_VERSION } from "../ai/schema";
import { buildDirectReading, MAX_READING_JSON_BYTES, parseExtracted, type DirectPart } from "./direct-reading";
import { classifyUpload, decodeText, sha256Hex, type MediaClass } from "./media";
import { projectDirectory } from "./project-port";
import type { OriginalKind, ReadKind, Via } from "./types";
import { imagesBinding, photoSourceHash, preparePhoto } from "./photo";

/** 一回に送れる量。画面の送るで足りる量（六枚前後）より十分大きく、Workers の要求の上限に収まる。 */
export const MAX_PARTS = 30;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;

export interface ReceivePart {
  /** photo はカメラ、file はファイル、text は一行の文 */
  kind: OriginalKind;
  filename: string;
  /** ブラウザが言う種類。信じず、先頭のバイトで見る */
  mediaType: string;
  bytes: Uint8Array;
  /** ブラウザで写真を整える前のSHA-256。同じ写真の再送の照合だけに使う。 */
  sourceHash?: string;
  /** Word と Excel をブラウザで展開した結果（JSON をパースした値）。無いと Word と Excel は受けない */
  extracted?: unknown;
}

export interface ReceiveInput {
  wardId: string;
  projectId?: string | null;
  via: Via;
  readKind?: ReadKind;
  accountId?: string | null;
  /** 公式 LINE の表示名など */
  senderLabel?: string;
  /** 送った単位。複数枚と裏表は一つにまとまり、一つの入った物になる */
  parts: ReceivePart[];
}

export type ReceiveErrorCode = "empty" | "too_many" | "too_large" | "unsupported" | "needs_expansion" | "bad_text" | "no_project";

export class ReceiveError extends Error {
  constructor(
    readonly code: ReceiveErrorCode,
    readonly filename: string = "",
  ) {
    super(`受けられませんでした（${code}）`);
    this.name = "ReceiveError";
  }
}

export interface ReceivedOriginal {
  originalId: string;
  filename: string;
  kind: OriginalKind;
}

export interface DuplicateOriginal {
  /** すでにある原本 */
  originalId: string;
  filename: string;
}

export interface ReceiveOutcome {
  /** 新しい物が一つも無ければ null（全部「同じ物でした」） */
  jobId: string | null;
  /** 読みが要る（画像と PDF がある）か。要るなら呼び出し側が pipeline.kick で裏の読みを始める */
  needsModelRead: boolean;
  received: ReceivedOriginal[];
  duplicates: DuplicateOriginal[];
}

interface PreparedPart {
  resizeFailed?: boolean;
  part: ReceivePart;
  mediaType: string;
  mediaClass: MediaClass;
  hash: string;
  bytes: Uint8Array;
  extracted?: ReturnType<typeof parseExtracted>;
  text?: string;
}

async function prepare(parts: ReceivePart[], projectId: string | null, env: Pick<Env, "DB" | "ORIGINALS">): Promise<PreparedPart[]> {
  if (parts.length === 0) throw new ReceiveError("empty");
  if (parts.length > MAX_PARTS) throw new ReceiveError("too_many");
  let total = 0;
  const prepared: PreparedPart[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      const text = decodeText(part.bytes).trim();
      if (text === "") throw new ReceiveError("empty");
      if (text.length > MAX_TEXT_CHARS) throw new ReceiveError("bad_text");
      const bytes = new TextEncoder().encode(text);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new ReceiveError("too_large", part.filename);
      prepared.push({
        part,
        mediaType: "text/plain",
        mediaClass: "text",
        // 一行の文は、同じプロジェクトの中で同じ文なら同じ物にする
        hash: await sha256Hex(`${projectId ?? ""}\n${text}`),
        bytes,
        text,
      });
      continue;
    }
    const classified = classifyUpload(part.bytes, part.mediaType, part.filename);
    if (!classified) throw new ReceiveError("unsupported", part.filename);
    const photo = classified.mediaClass === "image" ? await preparePhoto(part.bytes, classified.mediaType, imagesBinding(env)) : null;
    const bytes = photo?.bytes ?? part.bytes;
    if (bytes.length > MAX_FILE_BYTES) throw new ReceiveError("too_large", part.filename);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new ReceiveError("too_large", part.filename);
    const item: PreparedPart = {
      part: photo?.mediaType === "image/jpeg" && classified.mediaType !== "image/jpeg"
        ? { ...part, filename: `${part.filename.replace(/\.[^.]*$/, "")}.jpg` } : part,
      mediaType: photo?.mediaType ?? classified.mediaType,
      mediaClass: classified.mediaClass,
      // 変換方法とJPEGの出力差に左右されないよう、変換前の印を保つ。
      hash: (photo ? photoSourceHash(part.sourceHash) : undefined) ?? await sha256Hex(part.bytes),
      bytes,
      resizeFailed: photo?.resizeFailed,
    };
    if (classified.mediaClass === "word" || classified.mediaClass === "excel") {
      const extracted = parseExtracted(part.extracted);
      if (!extracted || extracted.format !== (classified.mediaClass === "word" ? "docx" : "xlsx")) {
        throw new ReceiveError("needs_expansion", part.filename);
      }
      item.extracted = extracted;
    } else if (classified.mediaClass === "text") {
      item.text = decodeText(part.bytes);
    }
    prepared.push(item);
  }
  return prepared;
}

async function findExistingHashes(
  db: D1Database,
  wardId: string,
  dedupeScope: string,
  hashes: string[],
): Promise<Map<string, DuplicateOriginal>> {
  const found = new Map<string, DuplicateOriginal>();
  if (hashes.length === 0) return found;
  const placeholders = hashes.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT content_hash, original_id, filename FROM originals
        WHERE ward_id = ? AND dedupe_scope = ? AND withdrawn_at IS NULL AND content_hash IN (${placeholders})`,
    )
    .bind(wardId, dedupeScope, ...hashes)
    .all<{ content_hash: string; original_id: string; filename: string }>();
  for (const row of res.results) found.set(row.content_hash, { originalId: row.original_id, filename: row.filename });
  return found;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** 受ける。同じ物は置かず、新しい物があれば一つの入った物にまとめる。 */
export async function receive(
  env: Pick<Env, "DB" | "ORIGINALS">,
  input: ReceiveInput,
  attempt = 0,
): Promise<ReceiveOutcome> {
  const projectId = input.projectId || null;
  // 存在しない、閉じたプロジェクトには送れない（繋げても、書く先が無くて全部捨てられる）
  if (projectId && !(await projectDirectory().isOpen(env.DB, input.wardId, projectId))) throw new ReceiveError("no_project");
  const prepared = await prepare(input.parts, projectId, env);

  const existing = await findExistingHashes(
    env.DB,
    input.wardId,
    projectId ?? "",
    prepared.map((p) => p.hash),
  );
  const seen = new Set<string>();
  const fresh: PreparedPart[] = [];
  const duplicates: DuplicateOriginal[] = [];
  for (const p of prepared) {
    const dup = existing.get(p.hash);
    if (dup) {
      duplicates.push(dup);
    } else if (seen.has(p.hash)) {
      // 同じ送信の中で同じ物が二度。先に置く方を指す
      duplicates.push({ originalId: "", filename: p.part.filename });
    } else {
      seen.add(p.hash);
      fresh.push(p);
    }
  }
  if (fresh.length === 0) return { jobId: null, needsModelRead: false, received: [], duplicates };

  const jobId = newId();
  const now = nowIso();
  const bucket = new WardBucket(env.ORIGINALS, input.wardId);
  const rows = fresh.map((p, i) => ({ p, originalId: newId(), position: i + 1, path: "" }));
  for (const r of rows) r.path = `originals/${r.originalId}`;

  await Promise.all(
    rows.map((r) =>
      bucket.put(r.path, r.p.bytes, {
        httpMetadata: { contentType: r.p.mediaType },
        customMetadata: r.p.resizeFailed ? { photoResizeFailed: "1" } : undefined,
      }),
    ),
  );

  // モデルで読む物（画像と PDF）と、そのまま読み取りにする物（Word、Excel、文字）に分ける
  const direct: DirectPart[] = [];
  let needsModelRead = false;
  for (const r of rows) {
    if (r.p.mediaClass === "image" || r.p.mediaClass === "pdf") needsModelRead = true;
    else if (r.p.extracted) direct.push({ originalId: r.originalId, filename: r.p.part.filename, extracted: r.p.extracted });
    else direct.push({ originalId: r.originalId, filename: r.p.part.filename, text: r.p.text });
  }
  const readKind: ReadKind = input.readKind ?? "general";
  const directReading = direct.length > 0 ? buildDirectReading(direct) : null;
  const directJson = directReading ? JSON.stringify(directReading) : null;
  if (directJson && new TextEncoder().encode(directJson).length > MAX_READING_JSON_BYTES) {
    await Promise.all(rows.map((r) => bucket.delete(r.path)));
    throw new ReceiveError("too_large");
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO jobs (job_id, ward_id, project_id, via, read_kind, sender_label, account_id, status, created_at, updated_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      input.wardId,
      projectId,
      input.via,
      readKind,
      (input.senderLabel ?? "").slice(0, 100),
      input.accountId ?? null,
      needsModelRead ? "received" : "read",
      now,
      now,
      needsModelRead ? null : now,
    ),
  ];
  for (const r of rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO originals (original_id, ward_id, job_id, position, kind, content_hash, dedupe_scope, media_type, filename, byte_size, r2_path, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        r.originalId,
        input.wardId,
        jobId,
        r.position,
        r.p.part.kind,
        r.p.hash,
        projectId ?? "",
        r.p.mediaType,
        r.p.part.filename.slice(0, 255),
        r.p.bytes.length,
        r.path,
        now,
      ),
    );
  }
  if (directJson) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
         VALUES (?, ?, ?, 'direct', ?, '', ?, ?)`,
      ).bind(newId(), input.wardId, jobId, READ_PACK_VERSION.direct, directJson, now),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    await Promise.all(rows.map((r) => bucket.delete(r.path)));
    // 同時に同じ物が二度来て、先に入った方が勝った。数え直してやり直す（一度だけ）
    if (isUniqueViolation(err) && attempt === 0) return receive(env, input, 1);
    throw err;
  }

  return {
    jobId,
    needsModelRead,
    received: rows.map((r) => ({ originalId: r.originalId, filename: r.p.part.filename, kind: r.p.part.kind })),
    duplicates,
  };
}
