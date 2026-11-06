import { getAnswerLabels } from "../settings/answer-labels";
// 入った物の読みの流れ。画面の応答の後に waitUntil で裏で動かす。
//
// waitUntil は応答を返した後、最長 30 秒しか続かない（Cloudflare の文書）。読みがそれを超えると黙って止められるので、
// 読み始める時に貸し出し（lease_until）を付け、切れた物と放ってある物を Cron（五分ごと）が読み直す。
// Cron は一回 15 分まで動ける。試行は MAX_READ_ATTEMPTS 回まで。
import type Anthropic from "@anthropic-ai/sdk";
import { WardBucket } from "../core/storage";
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import { createAnthropic, MODEL } from "../ai/anthropic";
import { dispatchProject } from "../ai/session";
import { matchProject, MATCH_NEW, MATCH_MULTIPLE, MATCH_UNRELATED } from "../ai/match";
import { projectApi } from "../ai/project-binding";
import { suggestProjects, SUGGEST_PACK_VERSION } from "../ai/suggest";
import { fixOriginalIds, ReadError, readOriginals, type ReadableOriginal } from "../ai/read";
import { lookupPaperCode } from "../print/qr";
import { addAnswer } from "../answers/api";
import {
  claimRead,
  closeAbandonedRuns,
  endRun,
  failExhaustedReads,
  failJob,
  finishRead,
  getJob,
  getReadings,
  listOriginals,
  listStuckReads,
  MAX_READ_ATTEMPTS,
  releaseRead,
  startRun,
  setJobProject,
  withdrawJob as withdrawStoredJob,
} from "./store";
import type { Waitable } from "./types";

export interface PipelineDeps {
  /** 試験で差し替える。既定は署名鍵から作る本物のクライアント */
  createClient?: (env: Env) => Anthropic;
  readImpl?: typeof readOriginals;
}

export type ReadOutcome = "read" | "failed" | "retry" | "skipped";

let defaultDeps: PipelineDeps | undefined;
// 同じ isolate で waitUntil と明示呼び出しが重なった場合、先に貸し出しを取った
// 呼び出しの結果を共有する。二つ目が単に "skipped" で返ると、呼び出し元が
// 読み取り完了前の状態を見てしまう。
const activeReads = new Map<string, Promise<ReadOutcome>>();

/** 試験で本物の Anthropic を呼ばないための差し替え口。null で戻す。 */
export function setPipelineDeps(deps: PipelineDeps | null): void {
  defaultDeps = deps ?? undefined;
}

/** 画面の応答の後に動かす時の貸し出し。waitUntil が止められても、これを過ぎれば Cron が拾う。 */
const LEASE_AFTER_RESPONSE_MS = 90_000;
/** Cron の中で読む時の貸し出し。 */
const LEASE_IN_CRON_MS = 10 * 60_000;

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "不明な失敗";
}

/** 一つの入った物を読む。取れた時だけ動き、結果を D1 に置く。 */
export function runRead(
  env: Env,
  wardId: string,
  jobId: string,
  options: { leaseMs?: number; deps?: PipelineDeps } = {},
): Promise<ReadOutcome> {
  const key = `${wardId}\0${jobId}`;
  const active = activeReads.get(key);
  if (active) return active;

  const run = performRead(env, wardId, jobId, options);
  activeReads.set(key, run);
  const clear = () => {
    if (activeReads.get(key) === run) activeReads.delete(key);
  };
  void run.then(clear, clear);
  return run;
}

async function performRead(
  env: Env,
  wardId: string,
  jobId: string,
  options: { leaseMs?: number; deps?: PipelineDeps },
): Promise<ReadOutcome> {
  const deps = options.deps ?? defaultDeps;
  const attempt = await claimRead(env.DB, wardId, jobId, options.leaseMs ?? LEASE_AFTER_RESPONSE_MS);
  if (attempt === null) return "skipped";

  const job = await getJob(env.DB, wardId, jobId);
  if (!job) return "skipped";
  await closeAbandonedRuns(env.DB, wardId, jobId);
  const run = await startRun(env.DB, { wardId, jobId, kind: "read", attempt, model: MODEL.main });

  try {
    const originals = (await listOriginals(env.DB, wardId, jobId)).filter(
      (o) => o.r2_path && (o.media_type.startsWith("image/") || o.media_type === "application/pdf"),
    );
    const client = (deps?.createClient ?? ((e: Env) => createAnthropic(e, { maxRetries: 1 })))(env);
    let direct = (await getReadings(env.DB, wardId, jobId)).find((row) => row.source === "direct");
    let directUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    if (!job.project_id && direct && "fields" in direct.body && direct.body.project_suggestions === undefined) {
      try {
        const directOriginals = (await listOriginals(env.DB, wardId, jobId)).filter((o) => !o.media_type.startsWith("image/") && o.media_type !== "application/pdf");
        const suggested = await suggestProjects(client, direct.body, directOriginals);
        direct = { ...direct, body: { ...direct.body, project_suggestions: suggested.suggestions },
          pack_version: `${direct.pack_version}/${SUGGEST_PACK_VERSION}`, model: suggested.model };
        directUsage = { ...suggested.usage, cache_read_input_tokens: suggested.usage.cache_read_input_tokens ?? 0 };
        await env.DB.prepare(`UPDATE readings SET body = ?, pack_version = ?, model = ? WHERE ward_id = ? AND job_id = ? AND source = 'direct'
          AND EXISTS (SELECT 1 FROM jobs WHERE ward_id = ? AND job_id = ? AND status = 'reading' AND attempt = ?)`)
          .bind(JSON.stringify(direct.body), direct.pack_version, direct.model, wardId, jobId, wardId, jobId, attempt).run();
      } catch (error) {
        if (originals.length === 0) throw error;
        // 写真の読みは続ける。文字の原本も残り、見立てが無くても始められる。
        console.error("文字の資料のまとめに失敗しました", describe(error));
      }
    }
    if (originals.length === 0) {
      if (!direct) throw new ReadError("読む原本がありません", "unsupported", false);
      const placed = await finishRead(env.DB, { wardId, jobId, attempt, source: "direct", packVersion: direct.pack_version,
        model: direct.model, body: direct.body });
      await endRun(env.DB, run, wardId, { ok: true, usage: directUsage });
      const latest = placed ? await getJob(env.DB, wardId, jobId) : null;
      if (latest?.project_id) await dispatchProject(env, wardId, latest.project_id).catch((error) => console.error("繋げるの起動に失敗しました", describe(error)));
      else if (placed) await matchUnassignedAdminJob(env, wardId, jobId, client).catch((error) => console.error("受け箱の当てに失敗しました", describe(error)));
      return placed ? "read" : "skipped";
    }
    const bucket = new WardBucket(env.ORIGINALS, wardId);
    const readable: ReadableOriginal[] = [];
    for (const o of originals) {
      const object = await bucket.get(o.r2_path as string);
      if (!object) {
        // 取り下げと行き違った。取り下げの方が先なので、何も置かない
        await endRun(env.DB, run, wardId, { ok: false, error: "原本の実体がありません" });
        await failJob(env.DB, wardId, jobId, "error");
        return "failed";
      }
      readable.push({
        originalId: o.original_id,
        filename: o.filename,
        mediaType: o.media_type,
        position: o.position,
        bytes: new Uint8Array(await object.arrayBuffer()),
      });
    }

    const answerLabels = job.read_kind === "answer_sheet" ? await getAnswerLabels(env.DB, wardId) : undefined;
    const result = await (deps?.readImpl ?? readOriginals)(client, { kind: job.read_kind, originals: readable, answerLabels });
    const placed = await finishRead(env.DB, {
      wardId,
      jobId,
      attempt,
      source: "model",
      packVersion: result.packVersion,
      model: result.model,
      body: fixOriginalIds(result.body, readable.map((original) => original.originalId)),
    });
    await endRun(env.DB, run, wardId, { ok: true, usage: { input_tokens: result.usage.input_tokens + directUsage.input_tokens, output_tokens: result.usage.output_tokens + directUsage.output_tokens, cache_read_input_tokens: result.usage.cache_read_input_tokens + directUsage.cache_read_input_tokens }, error: placed ? "" : "置く前に取り下げられました" });
    // 読み終わった。プロジェクトが決まっていれば、繋げる順番に入る（同じプロジェクトでは一つずつ）
    // 読みの間に当て先が付いた場合も、最新の入った物から当て先を拾う。
    let latest = placed ? await getJob(env.DB, wardId, jobId) : null;
    if (latest?.read_kind === "answer_sheet" && !latest.project_id) {
      latest = await routeByPaperCode(env.DB, wardId, jobId) ?? latest;
    }
    if (latest?.read_kind === "answer_sheet" && latest.project_id) {
      await saveAnswerSheetRows(env.DB, wardId, latest.project_id, jobId, latest.account_id);
    }
    if (latest?.project_id && latest.read_kind !== "answer_sheet") await dispatchProject(env, wardId, latest.project_id).catch((e) => console.error("繋げるの起動に失敗しました", describe(e)));
    else if (latest && (latest.via === "admin" || latest.via === "line_direct" || latest.via === "line_group")) await matchUnassignedAdminJob(env, wardId, jobId, client).catch((e) => console.error("受け箱の当てに失敗しました", describe(e)));
    return placed ? "read" : "skipped";
  } catch (err) {
    const read = err instanceof ReadError ? err : null;
    await endRun(env.DB, run, wardId, { ok: false, error: describe(err) });
    console.error("入った物の読みに失敗しました", wardId, jobId, describe(err));
    if (read && (!read.retryable || attempt >= MAX_READ_ATTEMPTS)) {
      await failJob(env.DB, wardId, jobId, read.failure);
      return "failed";
    }
    if (attempt >= MAX_READ_ATTEMPTS) {
      await failJob(env.DB, wardId, jobId, "error");
      return "failed";
    }
    await releaseRead(env.DB, wardId, jobId, attempt);
    return "retry";
  }
}

async function saveAnswerSheetRows(
  db: D1Database,
  wardId: string,
  projectId: string,
  jobId: string,
  accountId: string | null,
): Promise<void> {
  const readings = await getReadings(db, wardId, jobId);
  const reading = readings.find((row) => "rows" in row.body)?.body;
  if (!reading || !("rows" in reading)) return;
  await Promise.all(reading.rows.map(async (row, index) => {
    const household = row.household_name.trim();
    const district = row.ward_group.trim();
    if (!household) return;
    await addAnswer(db, wardId, {
      projectId,
      household,
      district,
      peopleCount: (row.adults ?? 0) + (row.children ?? 0) + (row.seniors ?? 0),
      childrenCount: row.children, adultsCount: row.adults, seniorsCount: row.seniors,
      helperName: row.helper_names.join("、"),
      helperTimes: row.helper_slots.join("、"),
      source: "sheet",
      originalId: row.original_id,
      sheetRowIndex: index,
      accountId,
    });
  }));
}

/** 役員画面から受け箱へ送られた写真を、読み終わってから自動で当てる。 */
async function matchUnassignedAdminJob(env: Env, wardId: string, jobId: string, client: Anthropic): Promise<void> {
  const current = await getJob(env.DB, wardId, jobId);
  if (!current || current.project_id || !["admin", "line_direct", "line_group"].includes(current.via) || current.status !== "read") return;
  const candidates = (await projectApi().listOpenProjects(env, wardId)).map((project) => ({
    id: project.projectId,
    title: project.title,
    detail: `${project.kind} ${project.year ?? ""}`.trim(),
  }));
  const readings = await getReadings(env.DB, wardId, jobId);
  // 複数の行事の資料を一つの行事へまとめて入れない。
  const suggested = new Set(readings.flatMap((row) => "fields" in row.body ? (row.body.project_suggestions ?? []).map((s) => `${s.kind}:${s.title}`) : []));
  if (suggested.size > 1) return;
  const paperCodes = readings.flatMap((reading) => {
    const body = reading.body;
    if ("rows" in body) return body.rows.map((row) => row.paper_code ?? "").filter(Boolean);
    return body.fields.map((field) => field.paper_code ?? "").filter(Boolean);
  });
  if (paperCodes.length > 0) {
    const routes = await Promise.all(paperCodes.map((code) => lookupPaperCode(env.DB, wardId, code)));
    const routedProjects = [...new Set(routes.flatMap((route) => route ? [route.projectId] : []))];
    // 印字符号がある紙は AI の候補選びに回さない。欄ごとの読みをプロジェクト別に渡す。
    if (routes.every(Boolean) && routedProjects.length === 1) {
      const selectedId = routedProjects[0] as string;
      const changed = await setJobProject(env.DB, wardId, jobId, selectedId);
      if (changed && current.read_kind !== "answer_sheet") await dispatchProject(env, wardId, selectedId);
    } else if (routes.every(Boolean) && routedProjects.length > 1 && readings.length === 1 && "fields" in readings[0]!.body) {
      await createPaperRouteJobs(env, current, readings[0]!.body, paperCodes, routes.map((route) => route?.projectId ?? ""));
    } else if (routes.some(Boolean)) {
      return;
    } else {
      // 符号が読めなかった場合は、従来どおり受け箱の候補から AI が当てる。
    }
    if (routes.every(Boolean) || routes.some(Boolean)) return;
  }
  const summary = readings.map((reading) => "summary" in reading.body ? reading.body.summary : "").filter(Boolean).join("\n").slice(0, 2000);
  if (!summary || candidates.length === 0) return;
  const result = await matchProject(client, { candidates, summary });
  const selected = candidates.find((candidate) => candidate.id === result.choice);
  if (selected) {
    const changed = await setJobProject(env.DB, wardId, jobId, selected.id);
    if (!changed) return;
    await env.DB.prepare("UPDATE jobs SET ai_matched_at = ?, ai_match_reason = ? WHERE ward_id = ? AND job_id = ? AND project_id = ?")
      .bind(nowIso(), result.reason, wardId, jobId, selected.id).run();
    if (current.read_kind !== "answer_sheet") await dispatchProject(env, wardId, selected.id);
  } else if (result.choice === MATCH_NEW || result.choice === MATCH_MULTIPLE || result.choice === MATCH_UNRELATED) {
    await env.DB.prepare("UPDATE jobs SET ai_match_reason = ? WHERE ward_id = ? AND job_id = ? AND project_id IS NULL")
      .bind(result.reason, wardId, jobId).run();
  }
  if (current.via === "line_direct" || current.via === "line_group") {
    if (selected) {
      await env.DB.prepare(`UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?, matched_project_name = ?, match_reason = ?
        WHERE ward_id = ? AND job_id = ?`).bind(selected.id, selected.title, result.reason, wardId, jobId).run();
    } else if (result.choice === MATCH_UNRELATED) {
      const item = await env.DB.prepare("SELECT item_id, received_at FROM line_inbox_items WHERE ward_id = ? AND job_id = ?")
        .bind(wardId, jobId).first<{ item_id: string; received_at: string }>();
      if (item) {
        await env.DB.prepare(`INSERT INTO line_unrelated_daily_counts (ward_id, day, item_count) VALUES (?, ?, 1)
          ON CONFLICT (ward_id, day) DO UPDATE SET item_count = item_count + 1`).bind(wardId, item.received_at.slice(0, 10)).run();
        await withdrawStoredJob(env, wardId, jobId).catch(() => false);
        await env.DB.prepare("DELETE FROM line_inbox_items WHERE ward_id = ? AND item_id = ?").bind(wardId, item.item_id).run();
      }
    } else {
      await env.DB.prepare("UPDATE line_inbox_items SET match_reason = ? WHERE ward_id = ? AND job_id = ?")
        .bind(result.reason, wardId, jobId).run();
    }
  }
}

async function createPaperRouteJobs(
  env: Env,
  source: NonNullable<Awaited<ReturnType<typeof getJob>>>,
  reading: import("../ai/schema").Reading,
  paperCodes: string[],
  projectIds: string[],
): Promise<void> {
  const fieldsByProject = new Map<string, import("../ai/schema").ReadField[]>();
  for (const [index, code] of paperCodes.entries()) {
    const projectId = projectIds[index];
    if (!projectId) continue;
    const fields = reading.fields.filter((field) => field.paper_code === code);
    fieldsByProject.set(projectId, [...(fieldsByProject.get(projectId) ?? []), ...fields]);
  }
  for (const [projectId, fields] of fieldsByProject) {
    if (fields.length === 0) continue;
    const now = nowIso();
    const childId = newId();
    await env.DB.prepare(`INSERT OR IGNORE INTO jobs
      (job_id, ward_id, project_id, via, task, read_kind, sender_label, account_id, status, created_at, updated_at, read_at, paper_source_job_id)
      VALUES (?, ?, ?, 'admin', 'connect', 'general', ?, ?, 'read', ?, ?, ?, ?)`)
      .bind(childId, source.ward_id, projectId, source.sender_label, source.account_id, now, now, now, source.job_id).run();
    const child = await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND paper_source_job_id = ? AND project_id = ?")
      .bind(source.ward_id, source.job_id, projectId).first<{ job_id: string }>();
    if (!child) continue;
    const body = { ...reading, fields,
      original_years: reading.original_years.filter((entry) => fields.some((field) => field.original_id === entry.original_id)),
      text_blocks: [], tables: [], decisions: [], unreadable: [] };
    await env.DB.prepare(`INSERT OR IGNORE INTO paper_reading_slices (ward_id, job_id, source_job_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(source.ward_id, child.job_id, source.job_id, JSON.stringify(body), now).run();
    await dispatchProject(env, source.ward_id, projectId);
  }
}

async function routeByPaperCode(db: D1Database, wardId: string, jobId: string) {
  const readings = await getReadings(db, wardId, jobId);
  const codes = readings.flatMap((reading) => {
    const body = reading.body;
    if ("rows" in body) return body.rows.map((row) => row.paper_code ?? "").filter(Boolean);
    return body.fields.map((field) => field.paper_code ?? "").filter(Boolean);
  });
  if (codes.length === 0) return null;
  const routes = await Promise.all(codes.map((code) => lookupPaperCode(db, wardId, code)));
  const projectIds = [...new Set(routes.flatMap((route) => route ? [route.projectId] : []))];
  if (!routes.every(Boolean) || projectIds.length !== 1) return null;
  const projectId = projectIds[0] as string;
  if (!(await setJobProject(db, wardId, jobId, projectId))) return null;
  return getJob(db, wardId, jobId);
}

/** 画面の応答の後に読みを始める。応答は待たない。 */
export function kickRead(env: Env, ctx: Waitable, wardId: string, jobId: string, deps?: PipelineDeps): void {
  ctx.waitUntil(
    runRead(env, wardId, jobId, { deps }).catch((err) => {
      console.error("読みの起動に失敗しました", wardId, jobId, describe(err));
    }),
  );
}

/** Cron（五分ごと）。止まっている読みを拾い直す。 */
export async function sweepReads(env: Env, deps?: PipelineDeps): Promise<{ picked: number; exhausted: number }> {
  const exhausted = await failExhaustedReads(env.DB);
  const stuck = await listStuckReads(env.DB);
  for (let i = 0; i < stuck.length; i += 3) {
    await Promise.all(
      stuck.slice(i, i + 3).map((s) =>
        runRead(env, s.ward_id, s.job_id, { leaseMs: LEASE_IN_CRON_MS, deps }).catch((err) => {
          console.error("読みの拾い直しに失敗しました", s.ward_id, s.job_id, describe(err));
        }),
      ),
    );
  }
  return { picked: stuck.length, exhausted };
}
