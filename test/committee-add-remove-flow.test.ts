import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

const person = { name: "架空 名簿太郎", role: "受付", contact: "000-0000-0701" };

it("資料を送らずに名簿へ一人足し、外しても履歴を残し、もう一度足せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の名簿の確認", year: 2026, accountId: account.accountId });
  const id = project.projectId;
  const path = `/${ward.slug}/admin/projects/${id}/committee`;
  await saveDocument(env.DB, ward.wardId, id, account.accountId, { kind: "duty_roster", title: "当番表", scope: "space", basedOn: 0, body: JSON.stringify({ text: "架空の説明", items: [] }) });
  const rows = async () => (await getProjectState(env.DB, ward.wardId, id))!.tables.committee;

  expect(await (await get(realApp, path, cookie)).text()).toContain("人を足す");
  expect((await postForm(realApp, path, person, cookie)).headers.get("location")).toContain("saved=1");
  expect(await rows()).toMatchObject([{ scope: "current", data: person, source: { kind: "person" } }]);
  expect((await env.DB.prepare("SELECT stale_since_version FROM documents WHERE ward_id = ? AND project_id = ? AND kind = 'duty_roster'").bind(ward.wardId, id).first<{ stale_since_version: number | null }>())?.stale_since_version).not.toBeNull();

  const again = await postForm(realApp, path, person, cookie);
  expect(again.status).toBe(400);
  expect(await again.text()).toContain(person.contact);
  expect(await rows()).toHaveLength(1);
  const blank = await postForm(realApp, path, { ...person, name: " " }, cookie);
  expect(blank.status).toBe(400);
  expect(await blank.text()).toContain(person.contact);

  const rowId = (await rows())[0]!.rowId;
  expect((await postForm(realApp, `/${other.ward.slug}/admin/projects/${id}/committee/${rowId}/remove`, {}, other.cookie)).status).toBe(404);
  expect(await rows()).toHaveLength(1);
  expect((await postForm(realApp, `${path}/${rowId}/remove`, {}, cookie)).headers.get("location")).toContain("removed=1");
  expect(await rows()).toHaveLength(0);
  expect(await env.DB.prepare("SELECT removed_by_account_id FROM project_rows WHERE ward_id = ? AND row_id = ?").bind(ward.wardId, rowId).first()).toEqual({ removed_by_account_id: account.accountId });
  expect(await env.DB.prepare("SELECT status, reason, created_by_account_id FROM project_changes WHERE ward_id = ? AND project_id = ? AND reason = 'removed'").bind(ward.wardId, id).first())
    .toEqual({ status: "applied", reason: "removed", created_by_account_id: account.accountId });
  expect(await (await get(realApp, `/${ward.slug}/admin/projects/${id}`, cookie)).text()).toContain("外しました");
  const notice = await (await get(realApp, `${path}?removed=1`, cookie)).text();
  expect(notice).toContain("名簿から外しました");
  expect(notice).toContain("今年の実行委員名簿はまだありません");

  expect((await postForm(realApp, `${path}/${rowId}/remove`, {}, cookie)).status).toBe(409);
  expect((await postForm(realApp, path, person, cookie)).status).toBe(303);
  expect(await rows()).toHaveLength(1);
});
