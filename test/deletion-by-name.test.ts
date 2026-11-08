import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("住民の名前で探すと、その人の返事と問い合わせだけが選ばれた形で出て、選んだ物だけが消える", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin/settings/deletion`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの夏祭り", year: 2026, accountId: account.accountId });
  for (const [answerId, household] of [["answer-yamada", "山田"], ["answer-yamashita", "山下"], ["answer-tanaka", "田中"]] as const) {
    await env.DB.prepare(`INSERT INTO project_answers (answer_id, ward_id, project_id, household, district, people_count, source)
      VALUES (?, ?, ?, ?, '1班', 2, 'phone')`).bind(answerId, ward.wardId, project.projectId, household).run();
  }
  await env.DB.prepare(`INSERT INTO inquiry_records (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_at, line_sender_label)
    VALUES ('inquiry-yamada', ?, '2026-11-07T01:00:00.000Z', 'inquiry', '駐車場はありますか', '', 0, '2026-11-07T01:00:00.000Z', '山田')`).bind(ward.wardId).run();

  const first = await (await get(realApp, root, cookie)).text();
  expect(first).toContain("頼んだ方のお名前");
  expect(first).not.toContain("つが見つかりました");

  // 名前は URL に入れず、送信の中身で探す。
  expect(first).toContain(`method="post" action="${root}/search"`);
  const found = await (await postForm(realApp, `${root}/search`, { name: "山田" }, cookie)).text();
  expect(found).toContain("「山田」で探すと、次の2つが見つかりました。");
  expect(found).toContain('value="answer:answer-yamada" checked');
  expect(found).toContain('value="inquiry:inquiry-yamada" checked');
  expect(found).not.toContain('value="answer:answer-tanaka"');

  const none = await (await postForm(realApp, `${root}/search`, { name: "鈴木" }, cookie)).text();
  expect(none).toContain("「鈴木」さんの分は見つかりませんでした。");

  // 似た名前の別の人（山下）は印を外した想定で、山田の返事と問い合わせだけを送る。
  const form = new URLSearchParams();
  form.append("target", "answer:answer-yamada");
  form.append("target", "inquiry:inquiry-yamada");
  const response = await realApp.request(`${root}/person`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: form.toString() }, env);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("queued=1");
  expect(response.headers.get("location")).not.toContain("name=");
  const left = await env.DB.prepare("SELECT answer_id FROM project_answers WHERE ward_id = ? ORDER BY answer_id").bind(ward.wardId).all<{ answer_id: string }>();
  expect(left.results.map((row) => row.answer_id)).toEqual(["answer-tanaka", "answer-yamashita"]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM inquiry_records WHERE ward_id = ?").bind(ward.wardId).first("n")).toBe(0);
});
