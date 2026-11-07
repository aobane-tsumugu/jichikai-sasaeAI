import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { getMemoRows } from "../src/map/memo";
import { get, postForm, realApp } from "./helpers";

it("資料のない一年目に運営メモを書き、情報なしのまま残し、行を足し、閉じた記録を来年の段取りで読む", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId });
  const root = `/${ward.slug}/admin`; const memo = `${root}/projects/${project.projectId}/ledger`;
  const security = `${memo}/${encodeURIComponent("template:security")}`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie); expect(response.status, path).toBe(200); return response.text();
  };
  const follow = async (response: Response) => {
    expect(response.status).toBe(303);
    const path = response.headers.get("location"); if (!path) throw new Error("操作のあとの画面がありません");
    return read(path);
  };
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_rows WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).first<{ n: number }>();
  expect(count?.n).toBe(0);
  expect(await read(`${root}/projects/${project.projectId}/map`)).toContain(`href="${memo}"><b>運営メモ`);
  const empty = await read(memo);
  expect(empty).toContain("警備"); expect(empty).toContain("情報なし"); expect(empty).toContain("参考の記録です");
  expect(empty).not.toContain("未入力"); expect(empty).not.toContain("確かめ中");
  expect(empty).not.toContain('href="' + root + '/ledger"');
  expect(await read(security)).not.toMatch(/<(?:input|select|textarea)\b[^>]*\brequired\b/);
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: "案内", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: fixture.publicAnnouncement, items: [{ key: "content", content: fixture.draftText }] }),
  })).toBe(true);
  const saved = await follow(await postForm(realApp, security, { what: "警備", note: fixture.nextYearChange }, cookie));
  expect(saved).toContain("メモを残しました"); expect(saved).toContain(fixture.nextYearChange); expect(saved).toContain("情報なし");
  let state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.tables.ledger.find((row) => row.data.what === "警備")?.data.amount).toBeUndefined();
  const withZero = await follow(await postForm(realApp, security, { what: "警備", amount: "0", note: fixture.nextYearChange, contact: fixture.requestedBy, estimate: "0" }, cookie));
  expect(withZero).toContain("0円");
  expect((await postForm(realApp, `${security}/remove`, {}, cookie)).status).toBe(404);
  expect((await postForm(realApp, `${security}/restore`, {}, cookie)).status).toBe(404);
  expect(await read(security)).not.toContain("使わない行");
  expect(await read(security)).toContain(fixture.nextYearChange);
  // 何も書かない行も足せる。あとから同じ行を直せる。
  const add = await read(`${memo}/new`);
  const action = /<form method="post" action="([^"]+\/ledger\/custom[^\"]+)"/.exec(add)?.[1];
  if (!action) throw new Error("メモを足す入口がありません");
  expect(await follow(await postForm(realApp, action, {}, cookie))).toContain("メモを残しました");
  // 別の区からは、行の読み書きができない。
  const otherPath = `/${other.ward.slug}/admin/projects/${project.projectId}/ledger/template%3Asecurity`;
  expect((await get(realApp, otherPath, other.cookie)).status).toBe(404);
  expect((await postForm(realApp, otherPath, { note: fixture.reportText }, other.cookie)).status).toBe(404);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, { body: fixture.reportText }, cookie)).status).toBe(303);
  const frozen = await read(memo); expect(frozen).toContain(fixture.nextYearChange); expect(frozen).not.toContain("行を足す");
  expect((await postForm(realApp, security, { note: fixture.reportText }, cookie)).status).toBe(409);
  expect((await postForm(realApp, `${security}/remove`, {}, cookie)).status).toBe(404);
  const started = await postForm(realApp, `${root}/archive/${project.projectId}/seed`, { title: fixture.nextYearTitle, year: String(fixture.nextYear), eventDay: fixture.eventDay }, cookie);
  expect(started.status).toBe(303);
  const startedPath = started.headers.get("location"); if (!startedPath) throw new Error("来年の行事がありません");
  const nextId = new URL(startedPath, "http://localhost").searchParams.get("started"); if (!nextId) throw new Error("来年の行事の名前がありません");
  const nextMemo = `${root}/projects/${nextId}/ledger`;
  const nextPage = await read(nextMemo); expect(nextPage).toContain(`${fixture.eventYear}年の額: 0円`); expect(nextPage).toContain(fixture.nextYearChange);
  const nextEdit = await read(`${nextMemo}/template%3Asecurity`); expect(nextEdit).toContain(fixture.requestedBy);
  expect(nextEdit).not.toMatch(/name="amount"[^>]*value="0"/);
  state = await getProjectState(env.DB, ward.wardId, nextId);
  if (!state) throw new Error("来年の段取りがありません");
  const nextRows = await getMemoRows(env.DB, ward.wardId, state);
  expect(nextRows.find((row) => row.key === "template:security")).toMatchObject({ data: { what: "警備" }, reference: { data: { amount: 0, note: fixture.nextYearChange } } });
  expect(nextRows.find((row) => row.key === "template:security")?.data.amount).toBeUndefined();
});
