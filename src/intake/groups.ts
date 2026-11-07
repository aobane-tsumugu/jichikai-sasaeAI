// 読み終わった資料を行事ごとに見せ、役員の「始める」で段取りにつなぐ。
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import { createProject, listOpenProjects, normalizeKey } from "../project/api";
import type { ProjectKind } from "../project/model";
import type { ProjectSuggestion } from "../ai/schema";
import { subset } from "./reading-subset";
import { cleanSuggestions } from "../ai/suggest";
import { startTask } from "../ai/api";
import { dispatchProject } from "../ai/session";
import { attachClarificationQuestions } from "../line/clarifications";
import { getDraftPack } from "../draft/packs";
import { initialDraftKind } from "../map/template";
import { getPublicContact } from "../settings/store";
import { getJob, getReadings, listOriginals, setJobProject, type ReadingRow } from "./store";
import type { OriginalRow, Waitable } from "./types";

export interface MaterialGroup {
  key: string;
  title: string;
  kind: ProjectSuggestion["kind"];
  materials: { jobId: string; original: OriginalRow; readings: ReadingRow[] }[];
  /** 同じ行事が進んでいれば、その行事。「始める」か「入れる」かはこれで決める。 */
  joins: { projectId: string; title: string; year: number } | null;
}

/** 当番や役員会の資料は、行事の資料の一部として送られる。行事と同じ題なら一つにまとめる。 */
const EVENT_KINDS: readonly ProjectSuggestion["kind"][] = ["event", "duty", "board_meeting"];
const kindFamily = (kind: ProjectSuggestion["kind"]) => EVENT_KINDS.includes(kind) ? "event" : kind;
const titleKey = (title: string) => normalizeKey(title).replace(/(令和\d+|20\d{2})年度?/g, "");

/** 読み手ごとに題の長さが揺れる（収穫祭と秋の収穫祭）。片方がもう片方を含めば同じ行事と見る。 */
function sameEvent(a: string, b: string): boolean {
  const left = titleKey(a), right = titleKey(b);
  return left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left));
}

/** 読み手が付けた題と同じ行事が進んでいれば返す。題の揺れは資料どうしを束ねる時と同じに見る。 */
function openProjectFor(group: Pick<MaterialGroup, "title" | "kind">, projects: Awaited<ReturnType<typeof listOpenProjects>>) {
  if (!group.title) return null;
  return projects.find((p) => kindFamily(p.kind) === kindFamily(group.kind) && sameEvent(p.title, group.title)) ?? null;
}

/** 役員に分類を求めない。読めた題の分だけ分け、題の無い資料は一緒に送った一番大きなまとまりに入れる。 */
export async function pendingMaterialGroups(db: D1Database, wardId: string): Promise<MaterialGroup[]> {
  const jobs = await db.prepare(`SELECT job_id FROM jobs WHERE ward_id = ? AND project_id IS NULL
    AND withdrawn_at IS NULL AND status = 'read' AND via IN ('admin', 'line_direct', 'line_group') ORDER BY created_at DESC, job_id LIMIT 40`)
    .bind(wardId).all<{ job_id: string }>();
  const groups: MaterialGroup[] = [];
  for (const job of jobs.results.reverse()) {
    const [originals, readings] = await Promise.all([listOriginals(db, wardId, job.job_id), getReadings(db, wardId, job.job_id)]);
    const suggestions = cleanSuggestions(readings.flatMap((row) => "fields" in row.body ? row.body.project_suggestions ?? [] : []), originals.map((o) => o.original_id));
    const unknown: MaterialGroup["materials"] = [];
    const inThisSend = new Set<MaterialGroup>();
    for (const original of originals.filter((o) => !o.withdrawn_at)) {
      const material = { jobId: job.job_id, original, readings };
      const suggestion = suggestions.find((s) => s.original_id === original.original_id);
      if (!suggestion) { unknown.push(material); continue; }
      let group = groups.find((g) => g.title && kindFamily(g.kind) === kindFamily(suggestion.kind) && sameEvent(g.title, suggestion.title));
      if (!group) {
        group = { key: `${kindFamily(suggestion.kind)}:${normalizeKey(suggestion.title)}`, title: suggestion.title, kind: suggestion.kind, materials: [], joins: null };
        groups.push(group);
      } else {
        if (suggestion.title.length > group.title.length) group.title = suggestion.title;
        if (suggestion.kind === "event") group.kind = "event";
      }
      group.materials.push(material);
      inThisSend.add(group);
    }
    const biggest = [...inThisSend].sort((a, b) => b.materials.length - a.materials.length)[0];
    if (biggest) biggest.materials.push(...unknown);
    else if (unknown.length) groups.push({ key: `unknown:${job.job_id}`, title: "", kind: "event", materials: unknown, joins: null });
  }
  const open = await listOpenProjects(db, wardId);
  for (const group of groups) group.joins = openProjectFor(group, open);
  return groups.sort((a, b) => Number(!a.title) - Number(!b.title) || b.materials.length - a.materials.length);
}

/** 一度に送った中に別の行事があれば、その原本だけを分ける。原本の ID と保管場所は保つ。 */
async function attachGroup(env: Env, wardId: string, group: MaterialGroup, projectId: string, projectTitle: string): Promise<void> {
  for (const jobId of new Set(group.materials.map((m) => m.jobId))) {
    const job = await getJob(env.DB, wardId, jobId);
    if (!job || job.project_id || job.status !== "read") continue;
    const selected = new Set(group.materials.filter((m) => m.jobId === jobId).map((m) => m.original.original_id));
    const originals = await listOriginals(env.DB, wardId, jobId);
    if (originals.every((o) => selected.has(o.original_id))) {
      await setJobProject(env.DB, wardId, jobId, projectId);
    } else {
      const childId = newId();
      const now = nowIso();
      const readings = await getReadings(env.DB, wardId, jobId);
      const remaining = new Set(originals.filter((o) => !selected.has(o.original_id)).map((o) => o.original_id));
      const statements = [env.DB.prepare(`INSERT INTO jobs
        (job_id, ward_id, project_id, via, read_kind, sender_label, account_id, status, created_at, updated_at, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'read', ?, ?, ?)`)
        .bind(childId, wardId, projectId, job.via, job.read_kind, job.sender_label, job.account_id, job.created_at, now, job.read_at)];
      for (const row of readings) {
        if (!("fields" in row.body)) continue;
        statements.push(env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(newId(), wardId, childId, row.source, row.pack_version, row.model, JSON.stringify(subset(row.body, selected)), now));
        statements.push(env.DB.prepare("UPDATE readings SET body = ? WHERE ward_id = ? AND job_id = ? AND source = ?")
          .bind(JSON.stringify(subset(row.body, remaining)), wardId, jobId, row.source));
      }
      for (const id of selected) statements.push(env.DB.prepare("UPDATE originals SET job_id = ? WHERE ward_id = ? AND job_id = ? AND original_id = ?")
        .bind(childId, wardId, jobId, id));
      await env.DB.batch(statements);
    }
    await env.DB.prepare(`UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?, matched_project_name = ?
      WHERE ward_id = ? AND job_id = ?`).bind(projectId, projectTitle, wardId, jobId).run();
  }
}

/** 題が読めない時は、送ったファイルの名前を仮の題にする。あとで直せる。 */
function groupTitle(group: MaterialGroup): string {
  return group.title || group.materials[0]?.original.filename?.replace(/\.[^.]+$/, "") || "届いた資料";
}

export async function startMaterialGroup(env: Env, ctx: Waitable, wardId: string, accountId: string, key: string, eventDay: string, choice: { projectId?: string; projectName?: string; kind?: ProjectKind } = {}) {
  const group = (await pendingMaterialGroups(env.DB, wardId)).find((g) => g.key === key);
  if (!group) return null;
  // 今年の準備の年。資料の年とは別で、原本の年を書き換えない。
  const year = eventDay ? Number(eventDay.slice(0, 4)) : new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  const chosen = choice.projectId ? (await listOpenProjects(env.DB, wardId)).find((p) => p.projectId === choice.projectId) : null;
  if (choice.projectId && !chosen) return null;
  // 日を入れて別の年を選んだ時だけ、同じ名前でも別の行事として始める。名前を入れた時は、その名前で新しくする。
  const existing = chosen ?? (!choice.projectName && group.joins && (!eventDay || group.joins.year === year) ? group.joins : null);
  if (existing) {
    await attachGroup(env, wardId, group, existing.projectId, existing.title);
    for (const jobId of new Set(group.materials.map((m) => m.jobId))) await attachClarificationQuestions(env.DB, wardId, jobId);
    // 進めている行事の下書きは役員が直している。資料を入れただけで作り直さない。
    ctx.waitUntil(dispatchProject(env, wardId, existing.projectId).catch((e) => console.error("仕事の起動に失敗しました", e instanceof Error ? e.name : "")));
    return { projectId: existing.projectId, joined: true };
  }
  const project = await createProject(env.DB, wardId, {
    title: choice.projectName || groupTitle(group), kind: choice.kind ?? group.kind, year, accountId, ...(eventDay ? { eventDay } : {}),
  });
  await attachGroup(env, wardId, group, project.projectId, choice.projectName || groupTitle(group));
  const pack = getDraftPack(initialDraftKind(project.kind), project.kind);
  const contact = await getPublicContact(env.DB, wardId);
  await startTask(env, ctx, { wardId, projectId: project.projectId, task: "draft", accountId,
    instruction: `${pack.instruction}${contact ? `\n区の公開用の連絡先: ${contact}` : ""}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。dataにpack_versionを${pack.version}、based_on_state_versionを引いた状態の番号として含めてください。` });
  return { projectId: project.projectId, joined: false };
}
