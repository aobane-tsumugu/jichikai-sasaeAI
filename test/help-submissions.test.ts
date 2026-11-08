import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getDutyDraftHelpers, setAnswerDeadline } from "../src/answers/api";
import { listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

const input = { helper_name: "試しの同名の手伝いさん", helper_times: "9時から10時" };
async function fixture(admin?: Awaited<ReturnType<typeof seedAdmin>>) {
  const setup = admin ?? await seedAdmin(env.DB);
  const { ward, account, cookie } = setup;
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの手伝い確認会", year: 2099, accountId: account.accountId,
  });
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "試しの募集", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "試しの準備を手伝ってください。", items: [{ key: "helper_slots", content: input.helper_times }] }),
  })).toBe(true);
  const row = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!row) throw new Error("試しの募集がありません。");
  expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
    documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  return { ...setup, project, path: `/${ward.slug}/help/${project.projectId}` };
}
function number(html: string) {
  const key = /name="submission_id" value="([^"]+)"/.exec(html)?.[1];
  if (!key) throw new Error("試しの申込みに送信番号がありません。");
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
  const replay = await postForm(realApp, path, { ...form, helper_name: "試しの書き換えたお名前" });
  expect(replay.status).toBe(200);
  const received = await replay.text();
  expect(received).toContain(input.helper_name);
  expect(received).not.toContain("試しの書き換えたお名前");
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

it("募集時間を変えた後の再送も保存済みの受付結果へ戻し、新しい申し込みは現在の時間で受ける", async () => {
  const { ward, account, cookie, project, path } = await fixture();
  const form = { ...input, submission_id: number(await (await get(realApp, path)).text()) };
  expect((await postForm(realApp, path, form)).status).toBe(200);
  const saved = await listHelpOffers(env.DB, ward.wardId, project.projectId);
  const current = await getProjectSummary(env.DB, ward.wardId, project.projectId);
  const nextTime = "14時から15時";
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "試しの募集", scope: "public", basedOn: current!.stateVersion,
    body: JSON.stringify({ text: "試しの準備時間を変えました。", items: [{ key: "helper_slots", content: nextTime }] }),
  })).toBe(true);
  const row = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!row) throw new Error("試しの変更後の募集がありません。");
  expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
    documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);

  for (const values of [form, { ...form, helper_name: "", helper_times: "" }]) {
    const replay = await postForm(realApp, path, values);
    expect(replay.status).toBe(200);
    const receipt = await replay.text();
    expect(receipt).toContain("申し込みを受け付けました");
    expect(receipt).toContain(input.helper_name);
    expect(receipt).toContain(input.helper_times);
  }
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toEqual(saved);
  const nextId = crypto.randomUUID();
  const invalid = await postForm(realApp, path, { ...input, submission_id: nextId });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain("募集にある時間帯を選んでください。");
  expect((await postForm(realApp, path, { ...input, helper_times: nextTime, submission_id: nextId })).status).toBe(200);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
});

it("締切後も保存済みの受付結果へ戻し、新規申し込みと閉じて消した申し込みは受け付けない", async () => {
  const { ward, account, cookie, project, path } = await fixture();
  const form = { ...input, submission_id: number(await (await get(realApp, path)).text()) };
  expect((await postForm(realApp, path, form)).status).toBe(200);
  const saved = await listHelpOffers(env.DB, ward.wardId, project.projectId);
  await setAnswerDeadline(env.DB, ward.wardId, project.projectId, "2000-01-01", account.accountId);
  const replay = await postForm(realApp, path, form);
  expect(replay.status).toBe(200);
  expect(await replay.text()).toContain(input.helper_name);
  expect((await postForm(realApp, path, { ...input, submission_id: crypto.randomUUID() })).status).toBe(400);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toEqual(saved);

  expect((await postForm(realApp, `/${ward.slug}/admin/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const closed = await postForm(realApp, path, form);
  expect(closed.status).toBe(400);
  expect(await closed.text()).not.toContain(input.helper_name);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(0);
});

it("役員が入れた手伝いも締切後の再送で元の保存結果へ戻り、取り消した申し込みは復活させない", async () => {
  const { ward, account, cookie, project } = await fixture();
  const root = `/${ward.slug}/admin/answers/${project.projectId}/help`;
  const form = { ...input, submission_id: number(await (await get(realApp, root, cookie)).text()) };
  const first = await postForm(realApp, root, form, cookie);
  expect(first.status).toBe(303);
  const location = first.headers.get("location");
  if (!location) throw new Error("試しの申し込みの保存結果がありません。");
  const saved = await listHelpOffers(env.DB, ward.wardId, project.projectId);
  expect(saved).toHaveLength(1);

  await setAnswerDeadline(env.DB, ward.wardId, project.projectId, "2000-01-01", account.accountId);
  for (const values of [form, { ...form, helper_name: "", helper_times: "" }]) {
    const replay = await postForm(realApp, root, values, cookie);
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(location);
    const receipt = await get(realApp, replay.headers.get("location")!, cookie);
    expect(receipt.status).toBe(200);
    const html = await receipt.text();
    expect(html).toContain(input.helper_name);
    expect(html).toContain(input.helper_times);
  }
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toEqual(saved);
  expect((await postForm(realApp, root, { ...form, submission_id: crypto.randomUUID() }, cookie)).status).toBe(409);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toEqual(saved);

  expect((await postForm(realApp, `${root}/${saved[0]!.offerId}/cancel`, {}, cookie)).status).toBe(200);
  expect((await postForm(realApp, root, form, cookie)).status).toBe(409);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(0);
});
