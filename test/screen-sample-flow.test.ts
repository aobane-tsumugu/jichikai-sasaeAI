import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer } from "../src/answers/api";
import { countText, countUnread } from "../src/answers/counts";
import { addHelpOffer, listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { materialChangeText } from "../src/map/material-change";
import type { ProjectState } from "../src/project/types";
import { get, postForm, realApp } from "./helpers";

const LABELS: [string, string, string] = ["子ども（中学生まで）", "大人（69歳まで）", "高齢の方（70歳以上）"];

it("読めなかった人数を参加しないと分け、人数は短い名前で書く", () => {
  const unread = { peopleCount: 0, childrenCount: null, adultsCount: null, seniorsCount: null };
  expect(countUnread(unread)).toBe(true);
  expect(countText(unread, LABELS)).toBe("人数が読めませんでした");
  expect(countText({ peopleCount: 0, childrenCount: 0, adultsCount: 0, seniorsCount: 0 }, LABELS)).toBe("参加しない");
  expect(countText({ peopleCount: 3, childrenCount: 1, adultsCount: 2, seniorsCount: 0 }, LABELS)).toBe("子ども1人、大人2人");
});

it("回答票で人数が読めなかった世帯を参加しないに数えず、答えの画面の上に出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の読み取り確認", year: 2026, accountId: account.accountId });
  await addAnswer(env.DB, ward.wardId, { projectId: project.projectId, household: "架空 読めない世帯", district: "", peopleCount: 0, childrenCount: null, adultsCount: null, seniorsCount: null, helperName: "", helperTimes: "", source: "sheet" });
  const page = await (await get(realApp, `/${ward.slug}/admin/answers/${project.projectId}`, cookie)).text();
  expect(page).toContain("人数が読めなかった答えが1件あります");
  expect(page).toContain("答えた1世帯のうち、参加する世帯は0、参加しない世帯は0です。人数が読めなかった世帯は1です。");
});

it("手伝いの同じ申し込みは一件だけ残し、間違えた時は入れた内容を残す", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の手伝い確認", year: 2026, accountId: account.accountId });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "架空の募集", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "架空の募集です", items: [{ key: "helper_slots", content: "午前、午後" }] }),
  });
  const version = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'recruitment'`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("募集が保存されていません");
  await env.DB.prepare(`INSERT INTO publication_records (ward_id, publication_id, project_id, document_id, version_id,
    version_no, line_status, published_at, published_by_account_id) VALUES (?, ?, ?, ?, ?, ?, 'not_sent', ?, ?)`)
    .bind(ward.wardId, crypto.randomUUID(), project.projectId, version.document_id, version.version_id,
      version.version_no, new Date().toISOString(), account.accountId).run();
  expect(await addHelpOffer(env.DB, ward.wardId, project.projectId, "架空 花子", "午前")).toBe(true);
  expect(await addHelpOffer(env.DB, ward.wardId, project.projectId, "架空 花子", "午前")).toBe(true);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);

  const helpPath = `/${ward.slug}/help/${project.projectId}`;
  const wrong = await postForm(realApp, helpPath, { helper_name: "", helper_times: "午後" });
  expect(wrong.status).toBe(400);
  const page = await wrong.text();
  expect(page).toContain("入れた内容は残っています");
  expect(page).toContain('value="午後" selected');
});

it("読み終わった物が無い時は読み終わりましたと言わず、新しく始める画面は入力だけにする", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const read = await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text();
  expect(read).toContain("読み終わったものはまだありません");
  expect(read).not.toContain("<h1>読み終わりました</h1>");
  await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の始める確認", year: 2026, accountId: account.accountId });
  const start = await (await get(realApp, `/${ward.slug}/admin/projects`, cookie)).text();
  expect(start).toContain("<h1>新しく始める</h1>");
  expect(start).not.toContain("架空の始める確認");
  const home = await (await get(realApp, `/${ward.slug}/admin/`, cookie)).text();
  expect(home).toContain(`href="/${ward.slug}/admin/projects/today"`);
  expect(home).toContain(`href="/${ward.slug}/admin/answers"`);
});

it("取り消したあとと、同じ資料だった時の結果を別の画面で出す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const cancelled = await (await get(realApp, `/${ward.slug}/admin/intake/received?n=withdrawn`, cookie)).text();
  expect(cancelled).toContain("<h1>送るのを取り消しました</h1>");
  expect(cancelled).toContain("資料は入っていません");
  const same = await (await get(realApp, `/${ward.slug}/admin/intake/received?n=same`, cookie)).text();
  expect(same).toContain("<h1>同じ資料でした</h1>");
  expect(same).toContain("二度は入れていません");
});

it("届いた資料で入ったことを一行で書き、多い時は短くする", () => {
  const source = (ref: string) => ({ kind: "original", ref, locator: null, year: 2026 });
  const value = (ref: string) => ({ valueId: ref, content: "架空", scope: "current", refYear: null, source: source(ref), confidence: "high", createdAt: "" });
  const item = (key: string, ref: string) => ({ key, label: key, current: value(ref), references: [] });
  const state = {
    items: [item("date_time", "a"), item("place", "a"), item("rain_plan", "b"), item("content", "b"), item("belongings", "b"), item("due", "b")],
    tables: { sponsors: [
      { scope: "current", data: { name: "架空商店", reply: "yes" }, source: source("c") },
      { scope: "current", data: { name: "架空薬局", reply: "pending" }, source: source("c") },
      { scope: "current", data: { name: "架空米店", reply: "" }, source: source("z") },
          { scope: "reference", data: { name: "架空酒店", reply: "yes" }, source: source("e") },
    ], duties: [], layout: [], ledger: [{ scope: "current", data: {}, source: source("d") }], decisions: [], submissions: [], committee: [] },
    questions: [{ source: source("a") }],
    mapTasks: [{ name: "会場を押さえる", progress: "done", progressSource: source("a") }],
  } as unknown as ProjectState;
  expect(materialChangeText(state, "a")).toBe("「会場を押さえる」を済みにしました。いつ、どこでを入れました。質問を一つ足しました");
  expect(materialChangeText(state, "b")).toBe("雨のとき、中身、持ち物など4項目を入れました");
  expect(materialChangeText(state, "c")).toBe("3軒のうち1軒の返事を入れました");
  expect(materialChangeText(state, "d")).toBe("運営メモに1行入れました");
  expect(materialChangeText(state, "e")).toBe("参考に、協賛先の一覧に1行入れました");
  expect(materialChangeText(state, "none")).toBe("");
});

it("段取りの最近届いた資料に、その資料から入った項目を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の資料確認", year: 2026, accountId: account.accountId });
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, via, read_kind, sender_label, account_id, project_id, status, created_at, updated_at, read_at)
    VALUES ('job-map', ?, 'admin', 'general', '架空', ?, ?, 'done', ?, ?, ?)`).bind(ward.wardId, account.accountId, project.projectId, now, now, now).run();
  await env.DB.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, filename, kind, media_type, content_hash, byte_size, received_at)
    VALUES ('original-map', ?, 'job-map', 0, '架空の案内.txt', 'text', 'text/plain', 'hash-map', 1, ?)`).bind(ward.wardId, now).run();
  await env.DB.prepare(`INSERT INTO project_item_values (value_id, ward_id, project_id, item_key, scope, content, source_kind, source_ref, confidence, created_at)
    VALUES ('value-map', ?, ?, 'place', 'current', '架空の公民館', 'original', 'original-map', 'high', ?)`).bind(ward.wardId, project.projectId, now).run();
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/map`, cookie)).text();
  expect(page).toContain("どこでを入れました");
  expect(page).not.toContain("読み終わりました。届いた資料で中身を見られます");
});
