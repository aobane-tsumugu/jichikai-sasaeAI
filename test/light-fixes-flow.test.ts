import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("名前に「自治会」が入る自治会を「〇〇自治会の自治会」と書かず、終わった行事と年間の予定を一年の表に二つ並べない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await env.DB.prepare("UPDATE wards SET name = ? WHERE ward_id = ?").bind("練習の自治会", ward.wardId).run();
  const root = `/${ward.slug}/admin`;
  const top = await (await get(realApp, `${root}/`, cookie)).text();
  expect(top).not.toContain("練習の自治会の自治会");

  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added) VALUES (?, ?, ?, 10, 1)").bind(ward.wardId, crypto.randomUUID(), "秋の収穫祭").run();
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-10-25" });
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind(new Date().toISOString(), ward.wardId, project.projectId).run();
  const year = await (await get(realApp, `${root}/year`, cookie)).text();
  expect(year.split("<b>秋の収穫祭</b>")).toHaveLength(2);
  expect(year).toContain("終わりにしました");
});

it("送ったものの画面は、役員が決めるのを待つ資料を「分けています」と書き続けない。入れたあとは入れた先を知らせる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const got = await receive(env, { wardId: ward.wardId, projectId: null, via: "admin", parts: [{ kind: "text", filename: "メモ.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("役員会のメモ") }] });
  await env.DB.prepare("UPDATE jobs SET status = 'read' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, got.jobId).run();
  const received = await (await get(realApp, `${root}/intake/received`, cookie)).text();
  expect(received).toContain("どの準備の資料かは、「読み終わったもの」から決められます。");
  expect(received).not.toContain("どの準備の資料かを分けています。");

  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
  const joined = await (await get(realApp, `${root}/intake/read?n=joined&project=${project.projectId}`, cookie)).text();
  expect(joined).toContain("「秋の収穫祭」の準備に資料を入れました");
  expect(joined).toContain(`href="${root}/projects/${project.projectId}/map">秋の収穫祭のやることを見る</a>`);
});
