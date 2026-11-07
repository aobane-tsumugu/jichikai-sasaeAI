import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { joinOpenProjects, pendingMaterialGroups } from "../src/intake/groups";
import { receive } from "../src/intake/receive";
import { listOriginals } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("前提 1: 一度に送った資料のうち、名前の合う準備中のものの分は押さなくても入り、合わない分は読み終わったものに残る。始める時に種類を聞かない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の秋の収穫祭", year: 2026, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: null, via: "admin", parts: [
    { kind: "text", filename: "収穫祭の案内.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の秋の収穫祭の案内") },
    { kind: "text", filename: "訓練の案内.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の防災の集まりの案内") },
  ] });
  if (!got.jobId) throw new Error("架空の資料を受け付けられませんでした");
  const originals = await listOriginals(env.DB, ward.wardId, got.jobId);
  const [harvest, drill] = originals;
  if (!harvest || !drill) throw new Error("架空の原本がありません");
  const body = { document_kind: "notice", original_years: [], summary: "架空の二つの案内", text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    project_suggestions: [
      { original_id: harvest.original_id, title: "秋の収穫祭", kind: "event", date_text: "", place: "" },
      { original_id: drill.original_id, title: "架空の防災の集まり", kind: "event", date_text: "", place: "" },
    ] };
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now, ward.wardId, got.jobId).run();
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'test@1', 'fixture', ?, ?)")
    .bind(crypto.randomUUID(), ward.wardId, got.jobId, JSON.stringify(body), now).run();

  expect(await joinOpenProjects(env, ward.wardId, got.jobId)).toEqual([project.projectId]);
  // 収穫祭の分は準備に入り、名前の合わない分だけが読み終わったものに残る
  const placed = await env.DB.prepare("SELECT o.original_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND j.project_id = ?")
    .bind(ward.wardId, project.projectId).all<{ original_id: string }>();
  expect(placed.results.map((row) => row.original_id)).toEqual([harvest.original_id]);
  const left = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(left.map((group) => group.title)).toEqual(["架空の防災の集まり"]);
  // 残った分を新しく始める時も、種類は聞かない
  const read = await (await get(realApp, `${root}/intake/read`, cookie)).text();
  expect(read).toContain("この資料は、次の準備のものですか？");
  expect(read).not.toContain("<legend>種類</legend>");
  expect(read).not.toContain('name="kind"');
});

it("古い形式の Word と Excel は選べ、送ると、何をすればよいかをその場で書く", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const page = await (await get(realApp, `${root}/intake`, cookie)).text();
  expect(page).toContain(".doc,.xls");
  const form = new FormData();
  form.set("project_id", "");
  form.append("part", new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3])], "架空の会計.xls", { type: "application/vnd.ms-excel" }));
  form.append("part_kind", "file");
  const response = await realApp.fetch(new Request(`http://localhost${root}/intake`, { method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form }), env);
  expect(((await response.json()) as { message: string }).message).toContain("「架空の会計.xls」は、古い形式のWordやExcelなので、中身を読めません。");
});
