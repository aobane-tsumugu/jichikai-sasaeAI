import type { Context, Hono } from "hono";
import type { AdminEnv } from "../env";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Choices } from "../core/choice";
import { formatJstDate, eventPeriodText } from "../core/time";
import { Notice } from "../core/ui";
import { listOpenProjects } from "../project/api";
import { getOrCreateWardNotices } from "../project/state";
import { getEditableDocument } from "../project/actions";
import { PROJECT_KIND_LABEL, type DocumentKind } from "../project/model";
import type { ProjectSummary } from "../project/types";
import { getDraftPack } from "./packs";
import { requestDraft } from "./request";

/**
 * 住民へのメッセージを作る入口（決定ログ L-311）。何を伝えるかと、どの準備のことかの二つだけを選び、
 * その準備に集まっている中身が入った下書きを開く。直す、画像を付ける、住民に送るは下書きの画面で行う。
 */
export const MESSAGE_KINDS: { kind: DocumentKind; title: string; note: string }[] = [
  { kind: "announcement", title: "行事の案内や宣伝", note: "いつ、どこで、何をするかを知らせ、来てもらうよう呼びかけます。出欠を聞く準備では、住民が返事をする入口も付きます。" },
  { kind: "recruitment", title: "手伝いの募集", note: "当日の手伝いなど、一回だけ関われる仕事を募ります。住民向けのページの「一回だけ手伝う」にも出ます。" },
  { kind: "notice", title: "連絡事項", note: "日時や場所の変更、持ち物、決まったことなどを、短く知らせます。" },
  { kind: "report", title: "終わった報告", note: "終わったあとに、何をして、どうだったかを知らせます。" },
];
const isMessageKind = (value: string): value is DocumentKind => MESSAGE_KINDS.some((entry) => entry.kind === value);
const WITHOUT_PROJECT = "ward-notices";

const projectNote = (project: ProjectSummary) => {
  const day = project.deadlines.event_day;
  return `${PROJECT_KIND_LABEL[project.kind]}です。${day ? `当日は${eventPeriodText(day, project.deadlines.event_end ?? day)}です。` : "当日はまだ決まっていません。"}`;
};

/** 住民向けにならない組み合わせ（役員会の文書、当番の連絡など）は、ここでは作らない。 */
const forResidents = (project: ProjectSummary, kind: DocumentKind) => getDraftPack(kind, project.kind).scope === "public";

async function picker(c: Context<AdminEnv>, error?: string, chosen: { kind?: string; projectId?: string } = {}) {
  const { ward, account } = c.var;
  const projects = (await listOpenProjects(c.env.DB, ward.wardId)).filter((project) => MESSAGE_KINDS.some((entry) => forResidents(project, entry.kind)));
  const kind = chosen.kind ?? c.req.query("kind") ?? "";
  const projectId = chosen.projectId ?? c.req.query("project") ?? (!projects.length ? WITHOUT_PROJECT : projects.length === 1 ? projects[0]!.projectId : "");
  const fixed = projects.find((project) => project.projectId === c.req.query("project"));
  // 同じ準備で、まだ住民に送っていない下書きがあれば先に出す。同じものを二つ作らないため。
  const unsent = await c.env.DB.prepare(`SELECT d.project_id, d.kind, COALESCE(v.title, d.title) AS title, v.created_at FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
    WHERE d.ward_id = ? AND p.closed_at IS NULL AND d.scope = 'public' AND d.kind IN ('announcement', 'recruitment', 'notice', 'report')
      AND v.published_at IS NULL AND v.version_no = (SELECT MAX(v2.version_no) FROM document_versions v2 WHERE v2.ward_id = v.ward_id AND v2.document_id = v.document_id)
    ORDER BY v.created_at DESC LIMIT 5`).bind(ward.wardId).all<{ project_id: string; kind: DocumentKind; title: string; created_at: string }>();
  const shown = unsent.results.filter((row) => !fixed || row.project_id === fixed.projectId);
  const back = fixed ? { href: adminPath(ward, `/projects/${fixed.projectId}/map`), label: `${fixed.title}のやることへ` } : { href: adminPath(ward, "/"), label: "最初の画面へ" };
  return c.html(<AdminPage ward={ward} account={account} title="住民へのメッセージを作る" back={back}>
    <h1>住民へのメッセージを作る</h1>
    <p class="lead">何を伝えるかと、どの準備のことかを選んでください。連絡事項は、準備に結び付けずに作れます。</p>
    {error ? <Notice error>{error}</Notice> : null}
    {shown.length ? <><p>まだ住民に送っていない下書きがあります。続きから直して送れます。</p><ul class="links">{shown.map((row) => <li><a href={adminPath(ward, `/projects/${row.project_id}/draft/${row.kind}?edit=1`)}>{row.title}（{formatJstDate(row.created_at)}に保存）</a></li>)}</ul></> : null}
    <form method="post" action={adminPath(ward, "/messages")}>
      <Choices name="kind" legend="何を伝えますか" items={MESSAGE_KINDS.map((entry) => ({ value: entry.kind, title: entry.title, note: entry.note, checked: entry.kind === kind }))} />
      {fixed ? <input type="hidden" name="projectId" value={fixed.projectId} />
        : <Choices name="projectId" legend="どの準備のことですか" items={[
          ...projects.map((project) => ({ value: project.projectId, title: project.title, note: projectNote(project), checked: project.projectId === projectId })),
          { value: WITHOUT_PROJECT, title: "どの準備でもない", note: "ごみの出し方の変更など、自治会全体への連絡事項を作ります。", checked: projectId === WITHOUT_PROJECT },
        ]} />}
      <div class="action-bar page-action"><button>作る</button></div>
      <p class="muted">押すと、下書きが開きます。準備を選ぶと、集まっている日時や場所などが入ります。AIが文を整える間も、手で直せます。まだ住民には送りません。</p>
    </form>
  </AdminPage>, error ? 400 : 200);
}

export function mountMessageRoutes(admin: Hono<AdminEnv>) {
  admin.get("/messages/new", (c) => picker(c));
  admin.post("/messages", async (c) => {
    const { ward, account } = c.var;
    const form = await c.req.formData();
    const kind = String(form.get("kind") ?? "");
    let projectId = String(form.get("projectId") ?? "");
    if (!isMessageKind(kind)) return picker(c, "何を伝えるかを選んでください。", { projectId });
    if (projectId === WITHOUT_PROJECT && kind !== "notice") return picker(c, "どの準備でもないものは、連絡事項を選んでください。", { kind, projectId });
    const project = projectId === WITHOUT_PROJECT
      ? await getOrCreateWardNotices(c.env.DB, ward.wardId, Number(new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 4)), account.accountId)
      : (await listOpenProjects(c.env.DB, ward.wardId)).find((entry) => entry.projectId === projectId);
    if (!project) return picker(c, "どの準備のことかを選んでください。", { kind });
    const label = MESSAGE_KINDS.find((entry) => entry.kind === kind)!.title;
    if (!forResidents(project, kind)) return picker(c, `${project.title}の${label}は、住民ではなく役員や当番の担当に向けたものなので、ここでは作れません。ほかの準備を選んでください。`, { kind, projectId });
    projectId = project.projectId;
    // event の連絡事項は、下書きが無いと雨の変更の画面になる。ここから来た時はいつもの下書きを開く。
    const path = `${adminPath(ward, `/projects/${projectId}/draft/${kind}`)}?edit=1`;
    if (await getEditableDocument(c.env.DB, ward.wardId, projectId, kind)) return c.redirect(path, 303);
    try { await requestDraft(c, project, kind); } catch { return c.redirect(`${path}&error=ai_failed`, 303); }
    return c.redirect(`${path}&notice=started`, 303);
  });
}
