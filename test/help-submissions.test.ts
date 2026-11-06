import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getDutyDraftHelpers } from "../src/answers/api";
import { listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

const input = { helper_name: "架空の同名の手伝いさん", helper_times: "9時から10時" };
async function fixture(admin?: Awaited<ReturnType<typeof seedAdmin>>) {
  const setup = admin ?? await seedAdmin(env.DB);
  const { ward, account, cookie } = setup;
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の手伝い確認会", year: 2099, accountId: account.accountId,
  });
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "架空の募集", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "架空の準備を手伝ってください。", items: [{ key: "helper_slots", content: input.helper_times }] }),
  })).toBe(true);
  const row = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!row) throw new Error("架空の募集がありません。");
  expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
    documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  return { ...setup, project, path: `/${ward.slug}/help/${project.projectId}` };
}
function number(html: string) {
  const key = /name="submission_id" value="([^"]+)"/.exec(html)?.[1];
  if (!key) throw new Error("架空の申込みに送信番号がありません。");
  return key;
}

it("同名で同じ時間の別々の申込みを2件残し、当番の資料へ渡す", async () => {
  const { ward, project, path } = await fixture();
  for (const submission_id of [crypto.randomUUID(), crypto.randomUUID()]) {
    expect((await postForm(realApp, path, { ...input, submission_id })).status).toBe(200);
  }
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
  expect(await getDutyDraftHelpers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
  // 既に開いている送信番号のない画面は、従来どおり同じ申込みへ戻す。
  expect((await postForm(realApp, path, input)).status).toBe(200);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
});

it("別フォームの番号を分け、入力エラー・同時送信・再送で同じ申込みを増やさない", async () => {
  const { ward, project, path } = await fixture();
  const first = await get(realApp, path);
  expect(first.headers.get("Cache-Control")).toContain("no-store");
  const key = number(await first.text());
  const other = number(await (await get(realApp, path)).text());
  expect(other).not.toBe(key);
  const form = { ...input, submission_id: key };
  const invalid = await postForm(realApp, path, { ...form, helper_times: "" });
  expect(invalid.status).toBe(400);
  expect(number(await invalid.text())).toBe(key);
  for (const response of await Promise.all([postForm(realApp, path, form), postForm(realApp, path, form)])) {
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  }
  const replay = await postForm(realApp, path, { ...form, helper_name: "架空の書き換えたお名前" });
  expect(replay.status).toBe(200);
  const received = await replay.text();
  expect(received).toContain(input.helper_name);
  expect(received).not.toContain("架空の書き換えたお名前");
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
  expect((await postForm(realApp, path, { ...input, submission_id: other })).status).toBe(200);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
});

it("同じ送信番号でも別の区と行事の手伝いをまとめない", async () => {
  const first = await fixture();
  const second = await fixture();
  const third = await fixture(first);
  const submission_id = crypto.randomUUID();
  for (const target of [first, second, third]) {
    expect((await postForm(realApp, target.path, { ...input, submission_id })).status).toBe(200);
    expect(await listHelpOffers(env.DB, target.ward.wardId, target.project.projectId)).toHaveLength(1);
  }
});
