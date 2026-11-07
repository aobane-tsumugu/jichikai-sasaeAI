import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { getJob, listOriginals } from "../src/intake/store";
import { get, postForm, realApp } from "./helpers";

async function readMaterial(wardId: string, text: string, summary: string, title?: string) {
  const got = await receive(env, { wardId, projectId: null, via: "admin", parts: [
    { kind: "text", filename: `${text}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(text) },
  ] });
  if (!got.jobId) throw new Error("資料を受け付けられませんでした");
  const [original] = await listOriginals(env.DB, wardId, got.jobId);
  const body = { document_kind: "other", original_years: [], summary, text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    project_suggestions: title ? [{ original_id: original!.original_id, title, kind: "event", date_text: "", place: "" }] : [] };
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now, wardId, got.jobId).run();
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'test@1', 'fixture', ?, ?)")
    .bind(crypto.randomUUID(), wardId, got.jobId, JSON.stringify(body), now).run();
  return got.jobId;
}

it("前提 21: どの準備の資料か分からなかった物は一つにまとめて何の資料かを書き、選んでまとめて消せる。年間の予定にある予定は月を書く", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added) VALUES (?, ?, ?, 12, 1)").bind(ward.wardId, crypto.randomUUID(), "年末の見回り").run();
  await readMaterial(ward.wardId, "見回りのお知らせ", "去年の年末の見回りのお知らせ。", "2025年度 年末の見回り");
  const book = await readMaterial(ward.wardId, "家計簿", "家庭の家計簿。自治会の資料ではないようです。");
  const ticket = await readMaterial(ward.wardId, "予約票", "歯医者の予約票。");

  const page = await (await get(realApp, `${root}/intake/read`, cookie)).text();
  expect(page).toMatch(/年間の予定では(今月（)?12月/);
  expect(page).toContain("どの準備の資料か分からなかったもの");
  expect(page).toContain("次の2件は、AIが読みましたが、どの準備の資料か分かりませんでした。");
  expect(page).toContain("家庭の家計簿。自治会の資料ではないようです。");
  expect(page).toContain("役員の画面から送りました。");
  expect(page).not.toContain("まだどれの資料にもしていないもの");
  expect(page.split(`action="${root}/intake/withdraw"`)).toHaveLength(2);
  expect(page.split('name="job"')).toHaveLength(3);

  const res = await postForm(realApp, `${root}/intake/withdraw`, { job: book, from: "read" }, cookie);
  expect(res.status).toBe(303);
  const after = await (await get(realApp, res.headers.get("location")!, cookie)).text();
  expect(after).toContain("1件の資料を消しました");
  expect(after).not.toContain("家庭の家計簿。");
  expect(after).toContain("歯医者の予約票。");
  expect(await getJob(env.DB, ward.wardId, book)).toMatchObject({ status: "withdrawn" });
  expect(await getJob(env.DB, ward.wardId, ticket)).toMatchObject({ status: "read" });
});

it("受け取った画面は、消す畳みを一つにし、どの準備からでもなく開いた時は LINE に届いた物を出さない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const mine = await receive(env, { wardId: ward.wardId, projectId: null, via: "admin", parts: [{ kind: "text", filename: "自分で送った.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("自分で送った") }] });
  await receive(env, { wardId: ward.wardId, projectId: null, via: "line_direct", parts: [{ kind: "text", filename: "LINEで届いた.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("LINEで届いた") }] });
  const page = await (await get(realApp, `/${ward.slug}/admin/intake/received`, cookie)).text();
  expect(page).toContain(`value="${mine.jobId}"`);
  expect(page).not.toContain("LINEで届いた");
  expect(page.split("<summary>間違えて送ったものを消す</summary>")).toHaveLength(2);
  expect(page).not.toContain("間違えて送ったときは");
});
