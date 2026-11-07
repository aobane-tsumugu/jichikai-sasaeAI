import { projectFeatures } from "../project/task-features";
import { getAnswerLabels } from "../settings/answer-labels";
import { listRecordWardIds } from "../archive/snapshot";
import { canStartJobAi, getWardAiLimits, recordAiMatchUsage } from "../ops/metrics";
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
import { applyWardReading } from "../know/apply";
import { yearItemsForStart } from "../know/year";
import { dispatchProject } from "../ai/session";
import { matchProject, MATCH_NEW, MATCH_MULTIPLE, MATCH_UNRELATED, MATCH_UNCERTAIN, MATCH_PACK_VERSION, OFFICER_MATCH_PACK_VERSION } from "../ai/match";
import { projectApi } from "../ai/project-binding";
import { suggestProjects, SUGGEST_PACK_VERSION } from "../ai/suggest";
import { fixOriginalIds, ReadError, readOriginals, type ReadableOriginal } from "../ai/read";
import { lookupPaperCode } from "../print/qr";
import { addAnswer } from "../answers/api";
import { meetingAnswerFromSheet } from "../answers/meeting";
import {
  claimRead,
  closeAbandonedRuns,
  endRun,
  failJob,
  finishRead,
  getJob,
  getReadings,
  listOriginals,
  MAX_READ_ATTEMPTS,
  releaseRead,
  startRun,
  setJobProject,
  withdrawJob as withdrawStoredJob,
} from "./store";
import type { Waitable } from "./types";
import { attachClarificationQuestions, processPhotoBatches } from "../line/clarifications";
import { clearPhotoTexts, photoContextProject, photoMatchCandidates, PHOTO_AFTER_MS, type PhotoBatchContext } from "../line/photo-context";
import { completePhotoMaterial } from "./material";
import { applyLineWardReading, bundleAction, ensureBundleQuestion, getBundleDecision, jobBundleDecision,
  removeReferenceYearItems, saveAiBundleDecision, type BundleDecision } from "../line/bundle-decisions";
import { lineBundleContents, lineBundlePhotoSummaries } from "../line/photo-context";
import { joinOpenProjects } from "./groups";

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
  if (!await canStartJobAi(env.DB, wardId, jobId)) return "skipped";
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
    const yearItems = job.read_kind === "answer_sheet" ? [] : await yearItemsForStart(env.DB, wardId);
    let direct = (await getReadings(env.DB, wardId, jobId)).find((row) => row.source === "direct");
    let directUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    if (!job.project_id && job.via !== "line_direct" && job.via !== "line_group" && direct && "fields" in direct.body && direct.body.project_suggestions === undefined) {
      try {
        const directOriginals = (await listOriginals(env.DB, wardId, jobId)).filter((o) => !o.media_type.startsWith("image/") && o.media_type !== "application/pdf");
        const suggested = await suggestProjects(client, direct.body, directOriginals, yearItems);
        direct = { ...direct, body: { ...direct.body, project_suggestions: suggested.suggestions, ward_facts: suggested.wardFacts, year_entries: suggested.yearEntries },
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
      if (!direct) throw new ReadError("読む元の資料がありません", "unsupported", false);
      const placed = await finishRead(env.DB, { wardId, jobId, attempt, source: "direct", packVersion: direct.pack_version,
        model: direct.model, body: direct.body });
      if (placed) await applyWardReading(env.DB, wardId, direct.body).catch((error) => console.error("自治会の情報を入れられませんでした", describe(error)));
      await endRun(env.DB, run, wardId, { ok: true, usage: directUsage });
      const latest = placed ? await getJob(env.DB, wardId, jobId) : null;
      if (latest?.project_id) await dispatchProject(env, wardId, latest.project_id).catch((error) => console.error("繋げるの起動に失敗しました", describe(error)));
      else if (placed) await matchUnassignedAdminJob(env, wardId, jobId, client).catch((error) => console.error("届いたものの当てに失敗しました", describe(error)));
      return placed ? "read" : "skipped";
    }
    const bucket = new WardBucket(env.ORIGINALS, wardId);
    const readable: ReadableOriginal[] = [];
    for (const o of originals) {
      const object = await bucket.get(o.r2_path as string);
      if (!object) {
        // 取り下げと行き違った。取り下げの方が先なので、何も置かない
        await endRun(env.DB, run, wardId, { ok: false, error: "元の資料の実体がありません" });
        await failJob(env.DB, wardId, jobId, "error");
        return "failed";
      }
      readable.push({
        originalId: o.original_id,
        filename: o.filename,
        mediaType: o.media_type,
        position: o.position,
        bytes: new Uint8Array(await object.arrayBuffer()),
        photoResizeFailed: object.customMetadata?.photoResizeFailed === "1",
      });
    }

    const answerLabels = job.read_kind === "answer_sheet" ? await getAnswerLabels(env.DB, wardId) : undefined;
    const answerFeatures = job.read_kind === "answer_sheet" && job.project_id
      ? await projectFeatures(env.DB, wardId, job.project_id) : null;
    const result = await (deps?.readImpl ?? readOriginals)(client, { kind: job.read_kind, originals: readable, yearItems, answerLabels, generalMeeting: answerFeatures?.delegation });
    const placed = await finishRead(env.DB, {
      wardId,
      jobId,
      attempt,
      source: "model",
      packVersion: result.packVersion,
      model: result.model,
      body: fixOriginalIds(result.body, readable.map((original) => original.originalId)),
    });
    if (placed && !await jobBundleDecision(env.DB, wardId, jobId)) {
      await applyWardReading(env.DB, wardId, fixOriginalIds(result.body, readable.map((original) => original.originalId))).catch((error) => console.error("自治会の情報を入れられませんでした", describe(error)));
      if (direct) await applyWardReading(env.DB, wardId, direct.body).catch((error) => console.error("自治会の情報を入れられませんでした", describe(error)));
    }
    await endRun(env.DB, run, wardId, { ok: true, usage: { input_tokens: result.usage.input_tokens + directUsage.input_tokens, output_tokens: result.usage.output_tokens + directUsage.output_tokens, cache_read_input_tokens: result.usage.cache_read_input_tokens + directUsage.cache_read_input_tokens }, error: placed ? "" : "置く前に取り下げられました" });
    const officerDecision = placed ? await jobBundleDecision(env.DB, wardId, jobId) : null;
    if (officerDecision) {
      // QRや写真の日時よりも、同じまとまりに添えられた目的を先に使う。
      await matchOfficerLineBundle(env, wardId, officerDecision, client, new Date());
      await processPhotoBatches(env, wardId).catch(() => undefined);
      return "read";
    }
    // 読み終わった。プロジェクトが決まっていれば、繋げる順番に入る（同じプロジェクトでは一つずつ）
    // 読みの間に当て先が付いた場合も、最新の入った物から当て先を拾う。
    let latest = placed ? await getJob(env.DB, wardId, jobId) : null;
    if (latest?.read_kind === "answer_sheet" && !latest.project_id) {
      latest = await routeByPaperCode(env.DB, wardId, jobId) ?? latest;
    }
    if (latest?.read_kind === "answer_sheet" && latest.project_id) {
      await saveAnswerSheetRows(env.DB, wardId, latest.project_id, jobId, latest.account_id);
    }
    if (latest?.project_id && latest.read_kind !== "answer_sheet") await connectReadJob(env, wardId, jobId, latest.project_id).catch((e) => console.error("繋げるの起動に失敗しました", describe(e)));
    else if (latest && (latest.via === "admin" || latest.via === "line_direct" || latest.via === "line_group")) await matchUnassignedAdminJob(env, wardId, jobId, client).catch((e) => console.error("届いたものの当てに失敗しました", describe(e)));
    if (placed) {
      await attachClarificationQuestions(env.DB, wardId, jobId).catch(() => undefined);
      if (!(await getWardAiLimits(env.DB, wardId)).monthlyBlocked) await processPhotoBatches(env, wardId).catch(() => undefined);
    }
    return placed ? "read" : "skipped";
  } catch (err) {
    const read = err instanceof ReadError ? err : null;
    await endRun(env.DB, run, wardId, { ok: false, error: describe(err) });
    console.error("届いたものの読みに失敗しました", wardId, jobId, describe(err));
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

async function connectReadJob(env: Env, wardId: string, jobId: string, projectId: string): Promise<void> {
  if (!(await completePhotoMaterial(env.DB, wardId, jobId))) await dispatchProject(env, wardId, projectId);
}

async function assignReadJob(env: Env, wardId: string, jobId: string, projectId: string, reason: string, ai = false): Promise<void> {
  if (ai) {
    // AIを待つ間に人や紙の符号で決まった当て先は上書きしない。
    const placed = await env.DB.prepare(`UPDATE jobs SET project_id = ?, updated_at = ?
      WHERE ward_id = ? AND job_id = ? AND project_id IS NULL AND status = 'read' AND withdrawn_at IS NULL`)
      .bind(projectId, nowIso(), wardId, jobId).run();
    if (!placed.meta.changes) return;
  } else if (!(await setJobProject(env.DB, wardId, jobId, projectId))) return;
  await env.DB.prepare("UPDATE jobs SET ai_matched_at = ?, ai_match_reason = ? WHERE ward_id = ? AND job_id = ? AND project_id = ?")
    .bind(ai ? nowIso() : null, reason, wardId, jobId, projectId).run();
  await env.DB.prepare(`UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
    matched_project_name = (SELECT title FROM projects WHERE ward_id = ? AND project_id = ?), match_reason = ?
    WHERE ward_id = ? AND job_id = ?`).bind(projectId, wardId, projectId, reason, wardId, jobId).run();
  const job = await getJob(env.DB, wardId, jobId);
  if (job?.read_kind === "answer_sheet") await saveAnswerSheetRows(env.DB, wardId, projectId, jobId, job.account_id);
  else await connectReadJob(env, wardId, jobId, projectId).catch((error) => {
    console.error("繋げるの起動に失敗しました", wardId, error instanceof Error ? error.name : "unknown");
  });
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
  const features = await projectFeatures(db, wardId, projectId);
  if (!features.attendance) return;
  await Promise.all(reading.rows.map(async (row, index) => {
    const household = row.household_name.trim();
    const district = row.ward_group.trim();
    if (!household) return;
      if (features.delegation) {
        const answer = meetingAnswerFromSheet(row);
        if (!answer || reading.unreadable.some((entry) => entry.original_id === row.original_id && entry.locator === row.locator)) return;
        await addAnswer(db, wardId, { projectId, household, district, peopleCount: 0, ...answer,
          source: "sheet", originalId: row.original_id, sheetRowIndex: index, accountId });
        return;
      }
    // 空欄と分かる人数は読み取りで0になる。不明な人数を補って一部だけ数えない。
    // 古い読み取りに高齢の方の欄自体が無い場合（undefined）は、従来どおり扱う。
    // 三つとも空で参加しないの印も無い行は、答えが無いのと同じ。0人の不参加にしない。
    if (!row.not_attending && (row.adults == null || row.children == null || row.seniors === null ||
      row.adults + row.children + (row.seniors ?? 0) === 0)) return;
    await addAnswer(db, wardId, {
      projectId,
      household,
      district,
      peopleCount: row.not_attending ? 0 : (row.adults ?? 0) + (row.children ?? 0) + (row.seniors ?? 0),
      childrenCount: row.not_attending ? 0 : row.children ?? 0, adultsCount: row.not_attending ? 0 : row.adults ?? 0, seniorsCount: row.not_attending ? 0 : row.seniors ?? 0,
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
  if (!await canStartJobAi(env.DB, wardId, jobId)) return;
  if (current.via === "line_direct" || current.via === "line_group") {
    const { resumeLimitedLineText } = await import("../line/intake");
    if (await resumeLimitedLineText(env, wardId, jobId)) return;
  }
  const candidates = (await projectApi().listOpenProjects(env, wardId)).map((project) => ({
    id: project.projectId,
    title: project.title,
    detail: `${project.kind} ${project.year ?? ""}`.trim(),
  }));
  const readings = await getReadings(env.DB, wardId, jobId);
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
      await assignReadJob(env, wardId, jobId, selectedId, "資料に書かれていた名前から決めました。");
    } else if (routes.every(Boolean) && routedProjects.length > 1 && readings.length === 1 && "fields" in readings[0]!.body) {
      await createPaperRouteJobs(env, current, readings[0]!.body, paperCodes, routes.map((route) => route?.projectId ?? ""));
    } else if (routes.some(Boolean)) {
      return;
    } else {
      // 符号が読めなかった場合は、従来どおり受け箱の候補から AI が当てる。
    }
    if (routes.every(Boolean) || routes.some(Boolean)) return;
  }
  const hasPhoto = (await listOriginals(env.DB, wardId, jobId)).some((original) => !original.withdrawn_at && original.media_type.startsWith("image/"));
  if (hasPhoto && current.via !== "admin") {
    await matchLinePhotoBatch(env, wardId, jobId, client);
    return;
  }
  // 紙の符号で決まらない場合は、読みから候補を選ぶ。
  const suggested = new Set(readings.flatMap((row) => "fields" in row.body ? (row.body.project_suggestions ?? []).map((s) => `${s.kind}:${s.title}`) : []));
  // 一度に違う準備の資料を送った時は、名前の合う準備中のものへ、その分だけ入れる。
  if (suggested.size > 1) { await joinOpenProjects(env, wardId, jobId); return; }
  const summary = readings.map((reading) => "summary" in reading.body ? reading.body.summary : "").filter(Boolean).join("\n").slice(0, 2000);
  if (!summary || candidates.length === 0) return;
  const result = await matchProject(client, { candidates: hasPhoto ? await photoMatchCandidates(env.DB, wardId) : candidates, summary, photo: hasPhoto });
  await recordAiMatchUsage(env.DB, wardId, result.usage);
  const selected = candidates.find((candidate) => candidate.id === result.choice);
  if (selected) {
    await assignReadJob(env, wardId, jobId, selected.id, result.reason, true);
  } else if ([MATCH_NEW, MATCH_MULTIPLE, MATCH_UNRELATED, MATCH_UNCERTAIN].includes(result.choice)) {
    await env.DB.prepare("UPDATE jobs SET ai_match_reason = ? WHERE ward_id = ? AND job_id = ? AND project_id IS NULL")
      .bind(result.reason, wardId, jobId).run();
    // AI が一つに決めきれない時も、資料に書かれた名前が準備中のものと合う分は入れる。新しい準備は役員が始める。
    if (current.via === "admin" && (result.choice === MATCH_MULTIPLE || result.choice === MATCH_UNCERTAIN)) await joinOpenProjects(env, wardId, jobId);
  }
  if (current.via === "line_direct" || current.via === "line_group") {
    if (selected) {
      await env.DB.prepare(`UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?, matched_project_name = ?, match_reason = ?
        WHERE ward_id = ? AND job_id = ?`).bind(selected.id, selected.title, result.reason, wardId, jobId).run();
    } else if (result.choice === MATCH_UNRELATED && !hasPhoto) {
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

/** 同時に届いた写真全体で一回当てる。10分後の文で決まらなければ既存の質問へ進む。 */
async function matchLinePhotoBatch(env: Env, wardId: string, jobId: string, client: Anthropic, now = new Date()): Promise<void> {
  if (!await canStartJobAi(env.DB, wardId, jobId)) return;
  const officerDecision = await jobBundleDecision(env.DB, wardId, jobId);
  if (officerDecision) {
    await matchOfficerLineBundle(env, wardId, officerDecision, client, now);
    return;
  }
  const batch = await env.DB.prepare(`SELECT b.* FROM line_photo_batches b JOIN line_photo_items i
    ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id WHERE b.ward_id = ? AND i.job_id = ?`)
    .bind(wardId, jobId).first<PhotoBatchContext & { expected_count: number | null }>();
  if (!batch || batch.match_finished_at) return;
  const items = await env.DB.prepare(`SELECT j.job_id, j.project_id, j.read_at FROM line_photo_items i
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE i.ward_id = ? AND i.batch_id = ? AND j.withdrawn_at IS NULL AND j.ai_limit_reason <> 'sender'
    ORDER BY i.image_index, j.created_at, i.job_id`)
    .bind(wardId, batch.batch_id).all<{ job_id: string; project_id: string | null; read_at: string | null }>();
  if (!items.results.length || items.results.some((item) => !item.read_at)) return;
  if (batch.expected_count !== null && items.results.length < batch.expected_count) return;
  if (batch.expected_count === null && now.getTime() - Date.parse(batch.last_received_at) < 5000) return;
  const final = now.getTime() >= Date.parse(batch.last_received_at) + PHOTO_AFTER_MS;
  if (batch.match_attempted_at && !final) return;
  const claim = await env.DB.prepare(`UPDATE line_photo_batches SET match_claimed_until = ?
    WHERE ward_id = ? AND batch_id = ? AND match_finished_at IS NULL
    AND (? = 1 OR match_attempted_at IS NULL)
    AND (match_claimed_until IS NULL OR match_claimed_until < ?)`)
    .bind(new Date(now.getTime() + 90_000).toISOString(), wardId, batch.batch_id, final ? 1 : 0, now.toISOString()).run();
  if (!claim.meta.changes) return;
  let resolved = items.results.every((item) => item.project_id);
  let reason = resolved ? "紙や答えから当て先が分かりました。" : batch.match_reason ?? "当て先を確認できませんでした。";
  try {
    if (!resolved) {
      const candidates = await photoMatchCandidates(env.DB, wardId);
      const context = await photoContextProject(env.DB, wardId, batch, now);
      // 文が増えていなければ同じ判断を繰り返さない。AI障害からの再試行は残す。
      if (batch.match_attempted_at && reason !== "当て先を確認できませんでした。" &&
        !context.after.some((text) => text.at > batch.match_attempted_at!)) return;
      const summaries = await Promise.all(items.results.map(async (item) => ({
        summary: (await getReadings(env.DB, wardId, item.job_id)).map((reading) => reading.body.summary).join("\n") || "文字のない写真",
        projectId: item.project_id,
      })));
      const result = await matchProject(client, { candidates, summary: JSON.stringify(summaries),
        photoContext: context });
      await recordAiMatchUsage(env.DB, wardId, result.usage);
      reason = result.reason;
      const chosen = result.confident && candidates.find((candidate) => candidate.id === result.choice);
      if (chosen) {
        for (const item of items.results.filter((item) => !item.project_id)) {
          await assignReadJob(env, wardId, item.job_id, chosen.id, result.reason, true);
        }
        resolved = true;
      }
    }
  } catch (error) {
    // 受け取った写真と読みはそのまま。AIの障害で受付や質問を止めない。
    console.error("写真の当て先を確認できませんでした", wardId, error instanceof Error ? error.name : "unknown");
  } finally {
    for (const item of items.results.filter((item) => !item.project_id)) {
      await env.DB.prepare("UPDATE jobs SET ai_match_reason = ? WHERE ward_id = ? AND job_id = ? AND project_id IS NULL")
        .bind(reason, wardId, item.job_id).run();
      await env.DB.prepare("UPDATE line_inbox_items SET match_reason = ? WHERE ward_id = ? AND job_id = ? AND disposition = 'unmatched'")
        .bind(reason, wardId, item.job_id).run();
    }
    await env.DB.prepare(`UPDATE line_photo_batches SET match_attempted_at = ?, match_finished_at = ?,
      match_claimed_until = NULL, match_reason = ?, match_pack_version = ? WHERE ward_id = ? AND batch_id = ?`)
      .bind(now.toISOString(), resolved || final ? now.toISOString() : null, reason, MATCH_PACK_VERSION, wardId, batch.batch_id).run();
    if (resolved || final) await clearPhotoTexts(env.DB, wardId, batch);
  }
}

/** 役員グループは写真の束でなく、言葉も含むまとまり全体で目的を読む。 */
async function matchOfficerLineBundle(env: Env, wardId: string, previous: BundleDecision, client: Anthropic, now: Date): Promise<void> {
  const latest = await env.DB.prepare(`SELECT MAX(received_at) AS received_at FROM line_webhook_receipts
    WHERE ward_id = ? AND bundle_id = ?`).bind(wardId, previous.bundle_id).first<{ received_at: string | null }>();
  if (!latest?.received_at || now.getTime() <= Date.parse(latest.received_at) + PHOTO_AFTER_MS) return;
  const contents = await lineBundleContents(env.DB, wardId, previous.bundle_id);
  if (!contents.photos.length) return;
  const jobs = await env.DB.prepare(`SELECT j.job_id, j.read_at, j.ai_limit_reason FROM jobs j JOIN line_inbox_items i
    ON i.ward_id = j.ward_id AND i.job_id = j.job_id WHERE j.ward_id = ? AND i.bundle_id = ?
    AND i.original_kind = 'image' AND j.withdrawn_at IS NULL`)
    .bind(wardId, previous.bundle_id).all<{ job_id: string; read_at: string | null; ai_limit_reason: string | null }>();
  if (!jobs.results.length || jobs.results.some((job) => !job.read_at || job.ai_limit_reason === "sender")) return;
  const incomplete = await env.DB.prepare(`SELECT 1 FROM line_photo_batches b JOIN line_photo_items p
    ON p.ward_id = b.ward_id AND p.batch_id = b.batch_id JOIN line_inbox_items i
    ON i.ward_id = p.ward_id AND i.job_id = p.job_id WHERE b.ward_id = ? AND i.bundle_id = ?
    AND b.expected_count IS NOT NULL AND b.expected_count >
      (SELECT COUNT(*) FROM line_photo_items x WHERE x.ward_id = b.ward_id AND x.batch_id = b.batch_id) LIMIT 1`)
    .bind(wardId, previous.bundle_id).first();
  if (incomplete) return;
  const unfinished = await env.DB.prepare(`SELECT 1 FROM line_photo_batches b JOIN line_photo_items p
    ON p.ward_id = b.ward_id AND p.batch_id = b.batch_id JOIN line_inbox_items i
    ON i.ward_id = p.ward_id AND i.job_id = p.job_id WHERE b.ward_id = ? AND i.bundle_id = ?
    AND b.match_finished_at IS NULL LIMIT 1`).bind(wardId, previous.bundle_id).first();
  if (!unfinished) return;
  let decision = previous;
  if (decision.decided_by !== "officer") {
    const candidates = await photoMatchCandidates(env.DB, wardId);
    const summaries = await lineBundlePhotoSummaries(env.DB, wardId, previous.bundle_id);
    const result = await matchProject(client, { candidates, summary: JSON.stringify(summaries), photoSummaries: summaries,
      accompanyingText: contents.text, officerGroup: true, photo: true });
    await recordAiMatchUsage(env.DB, wardId, result.usage);
    let chosen = result.confident ? candidates.find((candidate) => candidate.id === result.choice) : undefined;
    if (!chosen) {
      // 紙の番号は行き先だけに使う。参考かどうかは、添えた言葉から読んだ目的を守る。
      const codes = new Set<string>();
      for (const job of jobs.results) for (const reading of await getReadings(env.DB, wardId, job.job_id)) {
        const fields = "fields" in reading.body ? reading.body.fields : reading.body.rows;
        for (const field of fields) if (field.paper_code) codes.add(field.paper_code);
      }
      const routes = await Promise.all([...codes].map((code) => lookupPaperCode(env.DB, wardId, code)));
      const ids = new Set(routes.flatMap((route) => route ? [route.projectId] : []));
      if (routes.length && routes.every(Boolean) && ids.size === 1) chosen = candidates.find((candidate) => ids.has(candidate.id));
    }
    decision = await saveAiBundleDecision(env.DB, wardId, previous.bundle_id, result.reason,
      bundleAction(result), chosen ? chosen.id : null, now);
  }
  await removeReferenceYearItems(env.DB, wardId);
  await ensureBundleQuestion(env.DB, wardId, decision);
  await connectOfficerBundle(env, wardId, decision);
  await env.DB.prepare(`UPDATE line_photo_batches SET match_finished_at = ?, match_reason = ?, match_pack_version = ?
    WHERE ward_id = ? AND batch_id IN (SELECT p.batch_id FROM line_photo_items p JOIN line_inbox_items i
      ON i.ward_id = p.ward_id AND i.job_id = p.job_id WHERE p.ward_id = ? AND i.bundle_id = ?)`)
    .bind(now.toISOString(), decision.summary, OFFICER_MATCH_PACK_VERSION, wardId, wardId, previous.bundle_id).run();
}

/** 目的が分かった資料だけを準備へつなぐ。確認待ちは原本と読み取りを保つ。 */
export async function connectOfficerBundle(env: Env, wardId: string, decision: BundleDecision): Promise<void> {
  const saved = await getBundleDecision(env.DB, wardId, decision.bundle_id);
  if (!saved || (saved.action !== "material" && saved.action !== "reference")) return;
  const jobs = await env.DB.prepare(`SELECT j.job_id, j.project_id FROM jobs j JOIN line_inbox_items i
    ON i.ward_id = j.ward_id AND i.job_id = j.job_id WHERE j.ward_id = ? AND i.bundle_id = ?
    AND i.original_kind = 'image' AND j.read_at IS NOT NULL AND j.withdrawn_at IS NULL AND j.status = 'read'`)
    .bind(wardId, saved.bundle_id).all<{ job_id: string; project_id: string | null }>();
  for (const job of jobs.results) {
    if (saved.action === "reference") {
      // 参考は原本と読み取りを準備に結ぶ。今年の内容を作るエージェントへは渡さない。
      if (saved.project_id && await setJobProject(env.DB, wardId, job.job_id, saved.project_id)) {
        await env.DB.batch([
          env.DB.prepare(`UPDATE jobs SET status = 'done', finished_at = ?, stop_reason = '参考資料として残しました。',
            ai_match_reason = ? WHERE ward_id = ? AND job_id = ? AND project_id = ? AND withdrawn_at IS NULL`)
            .bind(nowIso(), saved.summary, wardId, job.job_id, saved.project_id),
          env.DB.prepare(`UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
            matched_project_name = (SELECT title FROM projects WHERE ward_id = ? AND project_id = ?),
            match_reason = ? WHERE ward_id = ? AND job_id = ?`)
            .bind(saved.project_id, wardId, saved.project_id, "参考資料として残しました。", wardId, job.job_id),
        ]);
      }
      continue;
    }
    if (saved.action === "material") await applyLineWardReading(env.DB, wardId, job.job_id);
    if (saved.project_id && !job.project_id) await assignReadJob(env, wardId, job.job_id, saved.project_id, saved.summary, true);
  }
}

/** 五分ごとの既存処理から、読み終えた写真の待ち時間とAI障害を拾う。 */
export async function matchPendingLinePhotos(env: Env, wardId: string, now = new Date()): Promise<void> {
  if ((await getWardAiLimits(env.DB, wardId, now)).monthlyBlocked) return;
  const batches = await env.DB.prepare(`SELECT (SELECT i.job_id FROM line_photo_items i WHERE i.ward_id = b.ward_id
    AND i.batch_id = b.batch_id ORDER BY i.image_index, i.job_id LIMIT 1) AS job_id
    FROM line_photo_batches b WHERE b.ward_id = ? AND b.match_finished_at IS NULL AND b.prepared_at IS NULL
    AND (b.match_attempted_at IS NULL OR b.last_received_at <= ?)
    AND NOT EXISTS (SELECT 1 FROM line_photo_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND j.withdrawn_at IS NULL AND j.read_at IS NULL)
    ORDER BY b.created_at LIMIT 30`).bind(wardId, new Date(now.getTime() - PHOTO_AFTER_MS).toISOString()).all<{ job_id: string | null }>();
  for (const batch of batches.results) if (batch.job_id) {
    const client = (defaultDeps?.createClient ?? ((e: Env) => createAnthropic(e, { maxRetries: 0, timeoutMs: 5000 })))(env);
    await matchLinePhotoBatch(env, wardId, batch.job_id, client, now);
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
  await db.prepare(`UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
    matched_project_name = (SELECT title FROM projects WHERE ward_id = ? AND project_id = ?),
    match_reason = '資料に書かれていた名前から決めました。' WHERE ward_id = ? AND job_id = ?`)
    .bind(projectId, wardId, projectId, wardId, jobId).run();
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
  let exhausted = 0;
  const stuck: Array<{ ward_id: string; job_id: string }> = [];
  const now = nowIso();
  for (const ward of await listRecordWardIds(env.DB)) {
    if ((await getWardAiLimits(env.DB, ward.ward_id)).monthlyBlocked) continue;
    const failed = await env.DB.prepare(`UPDATE jobs SET status = 'failed', failure = 'error', lease_until = NULL,
      finished_at = ?, updated_at = ? WHERE ward_id = ? AND ai_limit_reason = '' AND attempt >= ?
      AND (status = 'received' OR (status = 'reading' AND lease_until < ?))`)
      .bind(now, now, ward.ward_id, MAX_READ_ATTEMPTS, now).run();
    exhausted += failed.meta.changes ?? 0;
    const rows = await env.DB.prepare(`SELECT ward_id, job_id FROM jobs WHERE ward_id = ? AND ai_limit_reason <> 'sender'
      AND attempt < ? AND ((status = 'received' AND read_at IS NULL AND updated_at < ?) OR (status = 'reading' AND lease_until < ?))
      ORDER BY created_at LIMIT 20`)
      .bind(ward.ward_id, MAX_READ_ATTEMPTS, new Date(Date.now() - 60_000).toISOString(), now)
      .all<{ ward_id: string; job_id: string }>();
    stuck.push(...rows.results);
    // 読み終わってから月の上限に当たった資料は、読み直さず当て先の確認から続ける。
    const waiting = await env.DB.prepare(`SELECT job_id FROM jobs WHERE ward_id = ? AND status IN ('read', 'received') AND read_at IS NOT NULL
      AND project_id IS NULL AND ai_limit_reason = 'monthly' AND withdrawn_at IS NULL ORDER BY created_at LIMIT 20`)
      .bind(ward.ward_id).all<{ job_id: string }>();
    for (const job of waiting.results) {
      if (!await canStartJobAi(env.DB, ward.ward_id, job.job_id)) continue;
      try {
        const client = (deps?.createClient ?? defaultDeps?.createClient ?? ((e: Env) => createAnthropic(e)))(env);
        await matchUnassignedAdminJob(env, ward.ward_id, job.job_id, client);
      } catch (error) {
        await env.DB.prepare(`UPDATE jobs SET ai_limit_reason = 'monthly', status = 'received'
          WHERE ward_id = ? AND job_id = ? AND status = 'read' AND project_id IS NULL AND withdrawn_at IS NULL`)
          .bind(ward.ward_id, job.job_id).run();
        console.error("待っていた資料の当て先を確認できませんでした", ward.ward_id, error instanceof Error ? error.name : "unknown");
      }
    }
  }
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
