import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MEETING_NOTE_NAME } from "../src/answers/meeting";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { saveTemplates } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

it.each(["項目つき", "古い文だけ"])("%sの総会の追記は設定を変えても知らせ直すまで変わらず、空欄も保持する", async (format) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "general_meeting", title: "試しの追記確認総会", year: 2099, accountId: account.accountId,
  });
  const base = `/${ward.slug}`, id = project.projectId;
  const noteA = "試しの追記A。署名の場所は案内を見てください。";
  const noteB = "試しの追記B。押印については役員に聞いてください。";
  const changeNote = (body: string) => saveTemplates(env.DB, ward.wardId,
    [{ id: "meeting", name: MEETING_NOTE_NAME, body }], account.accountId);
  const draft = async () => {
    expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
      kind: "announcement", title: "試しの総会の案内", scope: "public", basedOn: project.stateVersion,
      body: JSON.stringify({ text: "試しの総会を開きます。", items: [] }),
    })).toBe(true);
    const row = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
      WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
      .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!row) throw new Error("試しの下書きがありません。");
    // 現在の入力は項目つき。古い保管形式だけ、試しの記録で再現する。
    if (format === "古い文だけ") await env.DB.prepare("UPDATE document_versions SET body = ? WHERE ward_id = ? AND version_id = ?")
      .bind("試しの総会を開きます。", ward.wardId, row.version_id).run();
    return { ...row, path: `${base}/admin/print/${id}/${row.document_id}/${row.version_no}` };
  };
  const publish = async (row: Awaited<ReturnType<typeof draft>>) => {
    expect((await postForm(realApp, `${base}/admin/publish/${id}/send`, {
      documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
  };
  const page = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };
  await changeNote(noteA);
  const first = await draft();
  await publish(first);
  await changeNote(noteB);
  expect(await page(`${base}/answer/${id}`)).toContain(noteA);
  for (const kind of ["announcement", "answer", "preview"]) {
    const html = await page(`${first.path}/${kind}`);
    expect(html).toContain(noteA);
    expect(html).not.toContain(noteB);
  }
  const invalid = await postForm(realApp, `${base}/answer/${id}`, { household: "", meeting_status: "attend" });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain(noteA);
  const second = await draft();
  expect(await page(`${second.path}/preview`)).toContain(noteB);
  expect(await page(`${base}/answer/${id}`)).toContain(noteA);
  await publish(second);
  expect(await page(`${base}/answer/${id}`)).toContain(noteB);
  expect(await page(`${second.path}/answer`)).toContain(noteB);
  expect(await page(`${first.path}/answer`)).toContain(noteA);
  // 空欄で配ったあと設定が変わっても、現在の設定へ戻らない。
  await changeNote("");
  const empty = await draft();
  await publish(empty);
  await changeNote(noteA);
  for (const path of [`${base}/answer/${id}`, `${empty.path}/answer`]) {
    const html = await page(path);
    expect(html).not.toContain(noteA);
    expect(html).not.toContain(noteB);
  }
});
