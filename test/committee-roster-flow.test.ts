import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { callTool } from "../src/ai/mcp";
import { checkPublicDraft } from "../src/check/index";
import { sha256Hex } from "../src/core/password";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { getReadings } from "../src/intake/store";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { createInvite, openSpace } from "../src/space/api";
import { currentPublicationTables } from "../src/space/publication-tables";
import { cookieFrom, get, postForm, realApp } from "./helpers";

const member = { name: "名簿役", role: "実行委員長", contact: "000-0000-0721 / committee@example.invalid" };

/** 受け付け・直接の読み取り・MCPの保存は実物を通し、AIが返す一行だけを試しの応答で置き換える。 */
async function importRoster(wardId: string, projectId: string, year: number, data = member) {
  const received = await receive(env, { wardId, projectId, via: "admin", parts: [{
    kind: "file", filename: `${year}年実行委員名簿.txt`, mediaType: "text/plain",
    bytes: new TextEncoder().encode(`${year}年の実行委員名簿（全て）\n名前\t役\t連絡先\n${data.name}\t${data.role}\t${data.contact}`),
  }] });
  if (!received.jobId || !received.received[0]) throw new Error("試しの名簿を受け付けられません。");
  const readings = await getReadings(env.DB, wardId, received.jobId);
  expect(JSON.stringify(readings)).toContain(data.contact);
  const ticket = `tk_${crypto.randomUUID()}`;
  await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND job_id = ?")
    .bind(await sha256Hex(ticket), wardId, received.jobId).run();
  const written = await callTool(env, wardId, "write_change", {
    ticket, kind: "row", target: "committee", original_id: received.received[0].originalId,
    locator: "3行目", data, confidence: "high",
  });
  expect(JSON.parse(written.content[0]!.text)).toMatchObject({ status: "applied" });
  await env.DB.prepare("UPDATE jobs SET status = 'done', ticket_hash = NULL WHERE ward_id = ? AND job_id = ?")
    .bind(wardId, received.jobId).run();
}

it("名簿の資料を表に入れ、役員が名前・役・連絡先を直して空間へ配り、公開には出さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの名簿確認会", year: 2026, accountId: account.accountId });
  const id = project.projectId;
  const root = `/${ward.slug}/admin`;
  const roster = `${root}/projects/${id}/committee`;
  const space = `/${ward.slug}/space/${id}`;
  await importRoster(ward.wardId, id, 2026);
  let state = await getProjectState(env.DB, ward.wardId, id);
  const row = state!.tables.committee[0]!;
  expect(row).toMatchObject({ scope: "current", data: member, source: { kind: "original" } });
  expect(await (await get(realApp, `${root}/projects/${id}`, cookie)).text()).toContain(roster);
  expect(await (await get(realApp, roster, cookie)).text()).toContain(member.contact);

  await openSpace(env.DB, ward.wardId, id, "試しの名簿用の合言葉", account.accountId);
  const cookies: string[] = [];
  for (const role of ["member", "leader"] as const) {
    const token = await createInvite(env.DB, ward.wardId, id, role, role === "leader" ? "1班" : null, account.accountId, true);
    const entered = await get(realApp, `${space}/person/${token}`);
    cookies.push(cookieFrom(entered, `space_${id}`)!);
    expect(await (await get(realApp, space, cookies.at(-1))).text()).not.toContain(member.contact);
  }
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "duty_roster", title: "試しの当番表", scope: "space", basedOn: state!.project.stateVersion,
    body: JSON.stringify({ text: "試しの準備のお知らせです。", items: [] }),
  })).toBe(true);
  const latest = async () => {
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'duty_roster' ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("配るものがありません。");
    return version;
  };
  const distribute = async () => {
    const version = await latest();
    expect((await postForm(realApp, `${root}/publish/${id}/space`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no),
    }, cookie)).status).toBe(303);
  };
  await distribute();
  for (const credential of cookies) {
    const html = await (await get(realApp, space, credential)).text();
    for (const value of Object.values(member)) expect(html).toContain(value);
  }
  expect(await (await get(realApp, space)).text()).not.toContain(member.contact);
  expect((await get(realApp, `/${other.ward.slug}/admin/projects/${id}/committee`, other.cookie)).status).toBe(404);
  expect((await postForm(realApp, `/${other.ward.slug}/admin/projects/${id}/committee/${row.rowId}`, member, other.cookie)).status).toBe(404);

  const next = { name: "名簿役の訂正", role: "副委員長", contact: "000-0000-0722 / changed@example.invalid" };
  expect((await postForm(realApp, `${roster}/${row.rowId}`, next, cookie)).status).toBe(303);
  state = await getProjectState(env.DB, ward.wardId, id);
  expect(state!.tables.committee).toHaveLength(1);
  expect(state!.tables.committee[0]).toMatchObject({ rowId: row.rowId, data: next, personFields: ["contact", "name", "role"] });
  expect(await (await get(realApp, space, cookies[0])).text()).toContain(member.contact);
  expect(await (await get(realApp, space, cookies[0])).text()).not.toContain(next.contact);
  await distribute();
  const updated = await (await get(realApp, space, cookies[0])).text();
  expect(updated).toContain(next.contact);
  expect(updated).not.toContain(member.contact);
  const invalid = await postForm(realApp, `${roster}/${row.rowId}`, { ...next, name: " " }, cookie);
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain(next.contact);
  expect(await checkPublicDraft(env.DB, ward.wardId, id, "announcement", { text: next.contact, items: [] }))
    .toContain(`個人の連絡先: ${next.contact}`);

  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "announcement", title: "試しの案内", scope: "public", basedOn: state!.project.stateVersion,
    body: JSON.stringify({ text: "試しの行事を開きます。", items: [] }),
  })).toBe(true);
  const announcement = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'announcement' ORDER BY v.version_no DESC LIMIT 1`)
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  expect((await postForm(realApp, `${root}/publish/${id}/send`, {
    documentId: announcement!.document_id, versionId: announcement!.version_id, versionNo: String(announcement!.version_no), lineDelivery: "skip", distribution: "",
  }, cookie)).status).toBe(303);
  for (const path of [`/${ward.slug}/`, `/${ward.slug}/p/${id}`]) {
    const publicPage = await get(realApp, path);
    expect(publicPage.status).toBe(200);
    const html = await publicPage.text();
    for (const value of [...Object.values(member), ...Object.values(next)]) expect(html).not.toContain(value);
  }
});

it("去年の実行委員は参考に留め、今年の名簿として配らない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの翌年の行事", year: 2026, accountId: account.accountId });
  await importRoster(ward.wardId, project.projectId, 2025);
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state!.tables.committee).toEqual([expect.objectContaining({ scope: "reference", refYear: 2025, data: member })]);
  expect(await currentPublicationTables(env.DB, ward.wardId, project.projectId)).toEqual([]);
});
