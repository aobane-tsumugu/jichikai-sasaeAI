// 役員画面の「送る」。カメラ、ファイル、一行の文を一つの画面から送る。送ったら受けたことをすぐ返し、読みは裏で続く。
// 画面に出す言葉は CLAUDE.md の表に従う（札、列、セッション、包み、版、差分は出さない）。
import { Hono } from "hono";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { receiveOriginal, ReceiveError, retryJob, withdrawJob } from "./api";
import { SEND_SCRIPT } from "./browser-script";
import { projectDirectory } from "./project-port";
import { getOriginal, listJobs, type JobListItem } from "./store";
import type { JobStatus, OriginalKind } from "./types";
import { WardBucket } from "../core/storage";
import type { ReceivePart } from "./receive";
import type { Waitable } from "./types";

/** Hono のテスト用 request には ExecutionContext が無い場合がある。 */
function waitableContext(context: { executionCtx: Waitable }): Waitable {
  try {
    return context.executionCtx;
  } catch {
    return { waitUntil: (promise) => void promise };
  }
}

/** 受けた直後に出す文（設計書 5.3）。 */
export const RECEIVED_MESSAGE = "受けました。閉じても処理は続きます。読み終わると、次に開いた時に見えます。";

export const STATUS_LABEL: Record<JobStatus, string> = {
  received: "受けました",
  reading: "読んでいます",
  read: "読み終わりました",
  connecting: "プロジェクトに反映しています",
  done: "反映しました",
  attention: "読み取りが遅れています。提供側で対応中です。案を書いて配ることはできます。",
  failed: "読めませんでした。もう一度送るか、このまま進めることもできます。",
  withdrawn: "取り下げました",
};

const ERROR_MESSAGE: Record<ReceiveError["code"], (filename: string) => string> = {
  empty: () => "送る物を選ぶか、一行の文を書いてください。",
  too_many: () => "一度に送れるのは 30 までです。分けて送ってください。",
  too_large: (f) => `${f ? `「${f}」` : "送った物"}が大きすぎます。小さくして送ってください。`,
  unsupported: (f) =>
    `${f ? `「${f}」` : "送った物"}は読めない形式です。写真、PDF、Word（.docx）、Excel（.xlsx）、文字のファイルを送ってください。`,
  needs_expansion: (f) =>
    `${f ? `「${f}」` : "Word や Excel"}は、この画面を開き直してから、ブラウザで送ってください（ブラウザが中身を開いて送ります）。`,
  bad_text: () => "一行の文が長すぎます。2 万文字までです。",
  no_project: () => "そのプロジェクトには送れません。プロジェクトを選び直してください。",
};

function isKind(value: string): value is OriginalKind {
  return value === "photo" || value === "file" || value === "text";
}

function jobTitle(job: JobListItem): string {
  if (job.first_kind === "text") return "一行の文";
  const name = job.first_filename || (job.first_kind === "photo" ? "撮った写真" : "ファイル");
  return job.original_count > 1 ? `${name} ほか ${job.original_count - 1} 件` : name;
}

function formatTime(iso: string): string {
  // 日本時間の月日と時分（この画面は役員が日本で使う前提）
  const jst = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

export const intakeAdmin = new Hono<AdminEnv>();

intakeAdmin.get("/intake", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.query("project") ?? "";
  const [choices, jobs] = await Promise.all([
    projectDirectory().listOpen(c.env.DB, ward.wardId),
    listJobs(c.env.DB, ward.wardId, { projectId: projectId || undefined }),
  ]);
  const notice = c.req.query("n");
  return c.html(
    <Layout title="送る" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
      <h1>送る</h1>
      <p class="muted">持っている形のまま送ってください。分類も名前付けも要りません。</p>
      {notice === "withdrawn" ? <Notice>取り下げました。</Notice> : null}
      {notice === "retry" ? <Notice>もう一度読みます。</Notice> : null}
      {c.req.query("error") ? <Notice error>{c.req.query("error")}</Notice> : null}
      <form id="send-form" method="post" action={adminPath(ward, "/intake")} enctype="multipart/form-data">
        {choices.length > 0 ? (
          <>
            <label for="project_id">どのプロジェクトか</label>
            <select id="project_id" name="project_id">
              <option value="" selected={!projectId}>プロジェクトに当てず受け箱へ</option>
              {choices.map((p) => (
                <option value={p.projectId} selected={p.projectId === projectId}>
                  {p.title}
                </option>
              ))}
            </select>
          </>
        ) : (
          <input type="hidden" name="project_id" value={projectId} />
        )}
        <label for="cam">撮る</label>
        <input id="cam" type="file" name="part" accept="image/*" capture="environment" multiple />
        <label for="files">ファイルを選ぶ</label>
        <input
          id="files"
          type="file"
          name="part"
          accept="image/*,application/pdf,.pdf,.docx,.xlsx,.txt,.csv"
          multiple
        />
        <label for="text">一行の文（電話や立ち話で決まったことなど）</label>
        <input id="text" type="text" name="text" maxlength={2000} />
        <p>
          <button id="send-button" type="submit">
            送る
          </button>
        </p>
        <p id="send-status" role="status" aria-live="polite" />
      </form>
      <script dangerouslySetInnerHTML={{ __html: SEND_SCRIPT }} />

      <h2>入った物</h2>
      {jobs.length === 0 ? <p class="muted">まだ何も入っていません。</p> : null}
      {jobs.map((job) => (
        <div class="panel">
          <strong>{jobTitle(job)}</strong>
          <div class="muted">{formatTime(job.created_at)}</div>
          <div>{STATUS_LABEL[job.status]}</div>
          {job.status === "failed" ? (
            <form class="inline" method="post" action={adminPath(ward, `/intake/${job.job_id}/retry`)}>
              <button type="submit" class="secondary">
                もう一度読む
              </button>
            </form>
          ) : null}{" "}
          {job.status === "received" || job.status === "reading" || job.status === "read" || job.status === "failed" ? (
            <form class="inline" method="post" action={adminPath(ward, `/intake/${job.job_id}/withdraw`)}>
              <button type="submit" class="danger">
                取り下げる
              </button>
            </form>
          ) : null}
        </div>
      ))}
    </Layout>,
  );
});

intakeAdmin.post("/intake", async (c) => {
  const { ward, account } = c.var;
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const reply = (ok: boolean, message: string, extra: Record<string, unknown> = {}, status: 200 | 400 = 200) => {
    if (wantsJson) return c.json({ ok, message, ...extra }, status);
    const back = adminPath(ward, "/intake");
    return c.redirect(`${back}${ok ? "" : `?error=${encodeURIComponent(message)}`}`, 303);
  };

  const form = await c.req.formData();
  const projectIdRaw = String(form.get("project_id") ?? "").trim();
  const projectId = projectIdRaw === "" ? null : projectIdRaw;
  if (projectId && !(await projectDirectory().isOpen(c.env.DB, ward.wardId, projectId))) {
    return reply(false, "そのプロジェクトには送れません。プロジェクトを選び直してください。", {}, 400);
  }

  const files = form.getAll("part").filter((v): v is File => typeof v !== "string" && v.size > 0);
  const kinds = form.getAll("part_kind").map(String);
  const extracted = form.getAll("part_extracted").map(String);
  const parts: ReceivePart[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as File;
    const kindRaw = kinds[i] ?? "file";
    const json = extracted[i] ?? "";
    let parsed: unknown;
    if (json !== "") {
      try {
        parsed = JSON.parse(json);
      } catch {
        return reply(false, ERROR_MESSAGE.needs_expansion(file.name), {}, 400);
      }
    }
    parts.push({
      kind: isKind(kindRaw) && kindRaw !== "text" ? kindRaw : "file",
      filename: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      extracted: parsed,
    });
  }
  const text = String(form.get("text") ?? "").trim();
  if (text !== "") parts.push({ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(text) });

  try {
    const outcome = await receiveOriginal(c.env, waitableContext(c), {
      wardId: ward.wardId,
      projectId,
      via: "admin",
      accountId: account.accountId,
      parts,
    });
    if (!projectId && !wantsJson) return c.redirect(adminPath(ward, "/inbox"), 303);
    if (!outcome.jobId) {
      return reply(true, "同じ物でした。", { jobId: null, duplicates: outcome.duplicates.length });
    }
    const dup = outcome.duplicates.length > 0 ? `（${outcome.duplicates.length} 件は同じ物でした）` : "";
    return reply(true, `${RECEIVED_MESSAGE}${dup}`, { jobId: outcome.jobId, duplicates: outcome.duplicates.length });
  } catch (err) {
    if (err instanceof ReceiveError) return reply(false, ERROR_MESSAGE[err.code](err.filename), {}, 400);
    throw err;
  }
});

intakeAdmin.post("/intake/:jobId/withdraw", async (c) => {
  const { ward } = c.var;
  await withdrawJob(c.env, ward.wardId, c.req.param("jobId"));
  return c.redirect(`${adminPath(ward, "/intake")}?n=withdrawn`, 303);
});

intakeAdmin.post("/intake/:jobId/retry", async (c) => {
  const { ward } = c.var;
  await retryJob(c.env, waitableContext(c), ward.wardId, c.req.param("jobId"));
  return c.redirect(`${adminPath(ward, "/intake")}?n=retry`, 303);
});

// 原本の実体。元の箇所へ戻る時に開く。区の中の物だけ。
intakeAdmin.get("/intake/originals/:originalId", async (c) => {
  const { ward } = c.var;
  const original = await getOriginal(c.env.DB, ward.wardId, c.req.param("originalId"));
  if (!original || !original.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, ward.wardId).get(original.r2_path);
  if (!object) return c.notFound();
  const inline = original.media_type.startsWith("image/") || original.media_type === "application/pdf" || original.media_type === "text/plain";
  const type = original.media_type === "text/plain" ? "text/plain; charset=utf-8" : original.media_type;
  return new Response(object.body, {
    headers: {
      "content-type": type,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(original.filename || "original")}`,
      "cache-control": "private, no-store",
    },
  });
});
