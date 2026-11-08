import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("見比べる画面に、二つの資料の違うところと手がかりを並べ、二つの元の資料へ行ける。問いの文に比べの文を重ねない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
  const ids: string[] = [];
  for (const text of ["秋の収穫祭は10月18日", "秋の収穫祭は10月25日"]) {
    const got = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [{ kind: "text", filename: `${text}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
    ids.push(got.received[0]!.originalId);
  }
  const sorted = [...ids].sort();
  const result = { descriptions: ["役員会のメモ", "役員会のメモ"], differences: ["秋の収穫祭の日が、一方は10月18日、もう一方は10月25日です。"], clues: ["どちらにも改訂を示す言葉はありません。"], newer: null, assessment: "中身からは、どちらが新しいか分かりません。" };
  await env.DB.prepare("INSERT INTO original_comparisons (ward_id, project_id, first_original_id, second_original_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ward.wardId, project.projectId, sorted[0], sorted[1], JSON.stringify(result), new Date().toISOString()).run();
  const comparisonText = "秋の収穫祭の日が、一方は10月18日、もう一方は10月25日です。どちらにも改訂を示す言葉はありません。中身からは、どちらが新しいか分かりません。";
  const questionId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO project_questions (question_id, ward_id, project_id, kind, text, target, detail, state, dedupe_key)
    VALUES (?, ?, ?, 'conflict', ?, 'date_time', ?, 'open', ?)`).bind(questionId, ward.wardId, project.projectId,
    `今年の「いつ」が、二つの資料で違います。${comparisonText}今年はどちらの中身にしますか。`,
    JSON.stringify({ options: ["10月18日（日）", "10月25日（日）"], comparisonKey: JSON.stringify(sorted), comparisonText, sources: ids.map((ref) => ({ kind: "original", ref })) }), `test:${questionId}`).run();
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/questions/${questionId}/compare`, cookie)).text();
  expect(page).toContain("<h2>二つの資料の違うところ</h2>");
  expect(page).toContain("<li>秋の収穫祭の日が、一方は10月18日、もう一方は10月25日です。</li>");
  expect(page).toContain("どちらが新しいかの手がかり");
  for (const id of sorted) expect(page).toContain(`/intake/originals/${id}`);
  // 問いの文には、比べの文を重ねて書かない。
  expect(page.split("秋の収穫祭の日が、一方は10月18日").length - 1).toBe(1);
});
