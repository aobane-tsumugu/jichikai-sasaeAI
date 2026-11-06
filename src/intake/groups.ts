// 読み終わった資料を行事ごとに見せ、役員の「始める」で段取りにつなぐ。
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import { createProject, listOpenProjects, normalizeKey } from "../project/api";
import type { ProjectSuggestion, Reading } from "../ai/schema";
import { cleanSuggestions } from "../ai/suggest";
import { startTask } from "../ai/api";
import { getDraftPack } from "../draft/packs";
import { getPublicContact } from "../settings/store";
import { getJob, getReadings, listOriginals, setJobProject, type ReadingRow } from "./store";
import type { OriginalRow, Waitable } from "./types";

export interface MaterialGroup {
  key: string;
  title: string;
  kind: ProjectSuggestion["kind"];
  materials: { jobId: string; original: OriginalRow; readings: ReadingRow[] }[];
}

export async function pendingMaterialGroups(db: D1Database, wardId: string): Promise<MaterialGroup[]> {
  const jobs = await db.prepare(`SELECT job_id FROM jobs WHERE ward_id = ? AND project_id IS NULL
    AND withdrawn_at IS NULL AND status = 'read' AND via IN ('admin', 'line_direct', 'line_group') ORDER BY created_at, job_id`)
    .bind(wardId).all<{ job_id: string }>();
  const groups = new Map<string, MaterialGroup>();
  for (const job of jobs.results) {
    const [originals, readings] = await Promise.all([listOriginals(db, wardId, job.job_id), getReadings(db, wardId, job.job_id)]);
    const suggestions = cleanSuggestions(readings.flatMap((row) => "fields" in row.body ? row.body.project_suggestions ?? [] : []), originals.map((o) => o.original_id));
    for (const original of originals.filter((o) => !o.withdrawn_at)) {
      const suggestion = suggestions.find((s) => s.original_id === original.original_id);
      const key = suggestion ? `${suggestion.kind}:${normalizeKey(suggestion.title)}` : `unknown:${job.job_id}`;
      const group = groups.get(key) ?? { key, title: suggestion?.title ?? "", kind: suggestion?.kind ?? "event", materials: [] };
      group.materials.push({ jobId: job.job_id, original, readings });
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

function subset(body: Reading, ids: Set<string>): Reading {
  const take = <T extends { original_id: string }>(rows: T[]) => rows.filter((row) => ids.has(row.original_id));
  return { ...body, summary: take(body.text_blocks).map((block) => block.text).join("\n").slice(0, 2000),
    original_years: take(body.original_years), text_blocks: take(body.text_blocks), fields: take(body.fields),
    tables: take(body.tables), decisions: take(body.decisions), unreadable: take(body.unreadable),
    project_suggestions: take(body.project_suggestions ?? []) };
}

/** 一度に送った中に別の行事があれば、その原本だけを分ける。原本の ID と保管場所は保つ。 */
async function attachGroup(env: Env, wardId: string, group: MaterialGroup, projectId: string): Promise<void> {
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
      WHERE ward_id = ? AND job_id = ?`).bind(projectId, group.title || "行事", wardId, jobId).run();
  }
}

export async function startMaterialGroup(env: Env, ctx: Waitable, wardId: string, accountId: string, key: string, eventDay: string) {
  const group = (await pendingMaterialGroups(env.DB, wardId)).find((g) => g.key === key);
  if (!group) return null;
  // 今年の準備の年。資料の年とは別で、原本の年を書き換えない。
  const year = eventDay ? Number(eventDay.slice(0, 4)) : new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  const existing = (await listOpenProjects(env.DB, wardId)).find((p) => p.kind === group.kind && p.year === year && normalizeKey(p.title) === normalizeKey(group.title));
  const project = existing ?? await createProject(env.DB, wardId, {
    title: group.title || "行事", kind: group.kind, year, accountId, ...(eventDay ? { eventDay } : {}),
  });
  await attachGroup(env, wardId, group, project.projectId);
  const pack = getDraftPack("announcement");
  const contact = await getPublicContact(env.DB, wardId);
  await startTask(env, ctx, { wardId, projectId: project.projectId, task: "draft", accountId,
    instruction: `${pack.instruction}${contact ? `\n区の公開用の連絡先: ${contact}` : ""}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。dataにpack_versionを${pack.version}、based_on_state_versionを引いた状態の番号として含めてください。` });
  return project;
}
