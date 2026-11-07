import { projectTasks, firstTaskDraft, taskDocumentKind } from "../project/task-features";
// 読み終わった資料を行事ごとに見せ、役員の「始める」で段取りにつなぐ。
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import { createProject, listOpenProjects, listProjects, normalizeKey } from "../project/api";
import { normalizeStartTitle, startTemplate } from "../project/start-template";
import { YEAR_BASE, yearItemsForStart } from "../know/year";
import { MAP_TEMPLATES, templatePeriod } from "../map/template";
import { copySeed } from "../archive";
import type { ProjectKind } from "../project/model";
import { cleanProjectSuggestions, type ProjectSuggestion } from "../ai/schema";
import { subset } from "./reading-subset";
import { startTask } from "../ai/api";
import { dispatchProject } from "../ai/session";
import { attachClarificationQuestions } from "../line/clarifications";
import { getDraftPack } from "../draft/packs";
import { getPublicContact } from "../settings/store";
import { getJob, getReadings, listOriginals, setJobProject, type ReadingRow } from "./store";
import type { OriginalRow, Waitable } from "./types";

export interface MaterialGroup {
  key: string;
  title: string;
  kind: ProjectSuggestion["kind"];
  /** この自治会の一年の予定の行の印。古い読みには無い。 */
  yearItem?: string;
  materials: { jobId: string; original: OriginalRow; readings: ReadingRow[] }[];
  /** 同じ行事が進んでいれば、その行事。「始める」か「入れる」かはこれで決める。 */
  joins: { projectId: string; title: string; year: number } | null;
}

/** 当番や役員会の資料は、行事の資料の一部として送られる。行事と同じ題なら一つにまとめる。 */
const titleKey = normalizeStartTitle;

/** 読み手ごとに題の長さが揺れる（収穫祭と秋の収穫祭）。片方がもう片方を含めば同じ行事と見る。 */
function sameEvent(a: string, b: string): boolean {
  const left = titleKey(a), right = titleKey(b);
  return left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left));
}

/** 読み手が付けた題と同じ行事が進んでいれば返す。題の揺れは資料どうしを束ねる時と同じに見る。 */
function openProjectFor(group: Pick<MaterialGroup, "title" | "kind">, projects: Awaited<ReturnType<typeof listOpenProjects>>) {
  if (!group.title) return null;
  return projects.find((p) => sameEvent(p.title, group.title)) ?? null;
}

/** 役員に分類を求めない。読めた題の分だけ分け、題の無い資料は一緒に送った一番大きなまとまりに入れる。 */
export async function pendingMaterialGroups(db: D1Database, wardId: string): Promise<MaterialGroup[]> {
  const jobs = await db.prepare(`SELECT job_id FROM jobs WHERE ward_id = ? AND project_id IS NULL
    AND withdrawn_at IS NULL AND status = 'read' AND via IN ('admin', 'line_direct', 'line_group') ORDER BY created_at DESC, job_id LIMIT 40`)
    .bind(wardId).all<{ job_id: string }>();
  const groups: MaterialGroup[] = [];
  const yearItems = await yearItemsForStart(db, wardId);
  for (const job of jobs.results.reverse()) {
    const [originals, readings] = await Promise.all([listOriginals(db, wardId, job.job_id), getReadings(db, wardId, job.job_id)]);
    const suggestions = cleanProjectSuggestions(readings.flatMap((row) => "fields" in row.body ? row.body.project_suggestions ?? [] : []), originals.map((o) => o.original_id));
    const unknown: MaterialGroup["materials"] = [];
    const inThisSend = new Set<MaterialGroup>();
    for (const original of originals.filter((o) => !o.withdrawn_at)) {
      const material = { jobId: job.job_id, original, readings };
      const suggestion = suggestions.find((s) => s.original_id === original.original_id);
      if (!suggestion) { unknown.push(material); continue; }
      const item = yearItems.find((entry) => entry.key === suggestion.year_item || entry.title === suggestion.year_item);
      // 同じ名前の行事は、AI が当てた一年の予定の行が違っても一つにまとめる。年間の予定の写真を読む前は型の行（秋の行事）、
      // 読んだ後は自治会の行（秋の収穫祭）を当てるので、行で分けると同じ行事の資料が二つに割れ、食い違いの質問が出なくなる。
      let group = groups.find((g) => g.title && (sameEvent(g.title, suggestion.title) || (item && g.yearItem === item.key)));
      if (!group) {
        group = { key: `material:${normalizeKey(suggestion.title)}`, title: suggestion.title, kind: "event", yearItem: item?.key, materials: [], joins: null };
        groups.push(group);
      } else {
        if (suggestion.title.length > group.title.length) group.title = suggestion.title;
        // 自治会の一年の予定の行（届いた年間の予定から読んだ物）を、型の行より優先する。
        if (item && (!group.yearItem || YEAR_BASE.some((base) => base.key === group!.yearItem))) group.yearItem = item.key;
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

/**
 * 読み終わった資料のうち、名前の合う準備中のものがある分は、役員が押さなくても入れる（前提 1。分ける判断は AI がし、役員は見て直すだけ）。
 * 違う時は、トークの「直す」で直せる。名前の合う準備が無い分は、今までどおり読み終わったものの画面で始めるか入れる。
 */
export async function joinOpenProjects(env: Env, wardId: string, jobId: string): Promise<string[]> {
  const groups = (await pendingMaterialGroups(env.DB, wardId)).filter((group) => group.joins && group.materials.some((material) => material.jobId === jobId));
  const joined: string[] = [];
  for (const group of groups) {
    const target = group.joins!;
    await attachGroup(env, wardId, { ...group, materials: group.materials.filter((material) => material.jobId === jobId) }, target.projectId, target.title);
    await env.DB.prepare("UPDATE jobs SET ai_match_reason = COALESCE(ai_match_reason, ?) WHERE ward_id = ? AND job_id = ? AND project_id = ?")
      .bind(`資料に書かれていた名前から、${target.title}に入れました。`, wardId, jobId, target.projectId).run();
    await attachClarificationQuestions(env.DB, wardId, jobId);
    await dispatchProject(env, wardId, target.projectId).catch((e) => console.error("仕事の起動に失敗しました", e instanceof Error ? e.name : ""));
    joined.push(target.projectId);
  }
  return joined;
}

/** 題が読めない時は、送ったファイルの名前を仮の題にする。あとで直せる。 */
function groupTitle(group: MaterialGroup): string {
  return group.title || group.materials[0]?.original.filename?.replace(/\.[^.]+$/, "") || "届いた資料";
}

/** 画面の説明と、始める時に同じ並びを使う。資料から読んだ種類は使わない。 */
export function materialGroupTemplate(group: MaterialGroup, past: Parameters<typeof startTemplate>[1], yearItems: Awaited<ReturnType<typeof yearItemsForStart>>, title = groupTitle(group)) {
  const item = normalizeStartTitle(title) === normalizeStartTitle(groupTitle(group))
    ? yearItems.find((entry) => entry.key === group.yearItem) : undefined;
  const template = startTemplate(item?.title ?? title, past, yearItems);
  const hasRota = group.materials.some((material) => material.readings.some(({ body }) => "fields" in body && (
    body.document_kind === "rota" || body.tables.some((table) => table.original_id === material.original.original_id
      // 列の名前は資料ごとに違う（「担当の世帯」「回る班」など）ので、言葉を含むかで見る。
      && table.columns.some((column) => /日|日付|日時/.test(column))
      && table.columns.some((column) => /班|組/.test(column))
      && table.columns.some((column) => /担当|当番|世帯/.test(column)))
  )));
  return hasRota && template.taskKeys?.join(",") === "announcement,day,report"
    ? { ...template, taskKeys: ["announcement", "assign", "day", "report"] } : template;
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
  const title = choice.projectName || groupTitle(group);
  const past = await listProjects(env.DB, wardId, { includeClosed: true });
  const yearItems = await yearItemsForStart(env.DB, wardId);
  const template = materialGroupTemplate(group, past, yearItems, title);
  const project = await createProject(env.DB, wardId, {
    title, kind: template.kind, year, accountId, ...(eventDay ? { eventDay } : {}),
    ...("taskKeys" in template && template.taskKeys ? { taskKeys: template.taskKeys } : {}),
    ...("seedProjectId" in template && template.seedProjectId ? { seedProjectId: template.seedProjectId } : {}),
  });
  const seed = "seedProjectId" in template && template.seedProjectId ? past.find((entry) => entry.projectId === template.seedProjectId) : undefined;
  if (seed) await copySeed(env.DB, wardId, seed.projectId, project.projectId, seed.year, eventDay || null);
  // 行事の短い型にはassignが無い。資料に当番表がある時だけ、知らせると当日の間に置く。
  if (template.taskKeys?.includes("assign")) {
    const assign = MAP_TEMPLATES.duty?.find((task) => task.key === "assign");
    if (assign) {
      const period = eventDay ? templatePeriod(assign, eventDay) : null;
      await env.DB.batch([
        env.DB.prepare("UPDATE project_map_tasks SET sort_order = sort_order + 1 WHERE ward_id = ? AND project_id = ? AND sort_order >= 1")
          .bind(wardId, project.projectId),
        env.DB.prepare(`INSERT INTO project_map_tasks
        (task_id, ward_id, project_id, task_key, name, period_start, period_end, offset_start_days, offset_end_days, sort_order, created_at)
        VALUES (?, ?, ?, 'assign', '担当を決める', ?, ?, ?, ?, 1, ?)`)
          .bind(newId(), wardId, project.projectId, period?.start ?? null, period?.end ?? null, assign.start, assign.end, nowIso()),
      ]);
    }
  }
  await attachGroup(env, wardId, group, project.projectId, choice.projectName || groupTitle(group));
  const tasks = await projectTasks(env.DB, wardId, project.projectId);
  const firstDraft = firstTaskDraft(tasks);
  const pack = getDraftPack(firstDraft, taskDocumentKind(tasks, firstDraft));
  const contact = await getPublicContact(env.DB, wardId);
  await startTask(env, ctx, { wardId, projectId: project.projectId, task: "draft", accountId,
    instruction: `${pack.instruction}${contact ? `\n区の公開用の連絡先: ${contact}` : ""}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。dataにpack_versionを${pack.version}、based_on_state_versionを引いた状態の番号として含めてください。` });
  return { projectId: project.projectId, joined: false };
}
