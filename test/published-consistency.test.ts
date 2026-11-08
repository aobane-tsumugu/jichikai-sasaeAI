import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { renameProject, saveDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import type { DocumentKind } from "../src/project/model";
import { get, postForm, realApp } from "./helpers";

async function fixture() {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "知らせたときの行事", year: 2026, accountId: account.accountId });
  const base = `/${ward.slug}`;
  const admin = `${base}/admin`;
  const draft = async (kind: DocumentKind, title: string, scope: "public" | "space", body: { text: string; items: { key: string; content: string }[] }) => {
    const state = await getProjectState(env.DB, ward.wardId, project.projectId);
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind, title, scope, body: JSON.stringify(body), basedOn: state!.project.stateVersion })).toBe(true);
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId, kind).first<{ document_id: string; version_id: string; version_no: number }>();
    return row!;
  };
  const publish = async (row: { document_id: string; version_id: string; version_no: number }, scope: "public" | "space") => {
    const result = await postForm(realApp, `${admin}/publish/${project.projectId}/${scope === "public" ? "send" : "space"}`, {
      documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
    }, cookie);
    expect(result.status).toBe(303);
  };
  return { ward, account, cookie, project, base, admin, draft, publish };
}

it.each(["public", "space"] as const)("%sに配り、古い下書きと二重の配布を防ぐ", async (scope) => {
  const f = await fixture();
  const kind = scope === "public" ? "announcement" : "duty_roster";
  const first = await f.draft(kind, "配布物", scope, { text: "試しの古い本文です。", items: [] });
  const latest = await f.draft(kind, "配布物", scope, { text: "試しの新しい本文です。", items: [] });
  const distribute = (row: typeof first) => postForm(realApp,
    `${f.admin}/publish/${f.project.projectId}/${scope === "public" ? "send" : "space"}`, {
      documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
    }, f.cookie);
  const readVersion = (versionId: string) => env.DB.prepare(`SELECT body, published_at FROM document_versions
    WHERE ward_id = ? AND version_id = ?`).bind(f.ward.wardId, versionId)
    .first<{ body: string; published_at: string | null }>();
  const records = () => env.DB.prepare("SELECT COUNT(*) AS n FROM publication_records WHERE ward_id = ? AND project_id = ?")
    .bind(f.ward.wardId, f.project.projectId).first<number>("n");

  expect((await distribute(first)).status).toBe(409);
  expect((await readVersion(first.version_id))?.published_at).toBeNull();
  expect(await records()).toBe(0);
  expect((await distribute(latest)).status).toBe(303);
  const published = await readVersion(latest.version_id);
  expect(published?.published_at).toEqual(expect.any(String));
  expect(await records()).toBe(scope === "public" ? 1 : 0);
  expect((await distribute(latest)).status).toBe(scope === "public" ? 404 : 303);
  expect(await readVersion(latest.version_id)).toEqual(published);
  expect(await records()).toBe(scope === "public" ? 1 : 0);

  if (scope === "space") {
    expect((await applyChange(env.DB, f.ward.wardId, f.project.projectId, {
      kind: "row", table: "duties", data: { slot: "試しの午前", assignee: "試しの担当" },
      source: { kind: "person", accountId: f.account.accountId }, confidence: "high", packVersion: "fictional-consistency@1",
    })).status).toBe("applied");
    expect((await distribute(latest)).status).toBe(303);
    const republished = await env.DB.prepare(`SELECT version_no, published_at FROM document_versions
      WHERE ward_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 1`)
      .bind(f.ward.wardId, latest.document_id).first<{ version_no: number; published_at: string | null }>();
    expect(republished?.version_no).toBe(latest.version_no + 1);
    expect(republished?.published_at).toEqual(expect.any(String));
    expect(await readVersion(latest.version_id)).toEqual(published);
  }
});

it.each(["public", "space"] as const)("行事名を直しても%sに配った紙の題を保ち、下書きと次に配る紙には新しい題を使う", async (scope) => {
  const f = await fixture();
  const kind = scope === "public" ? "announcement" : "duty_roster";
  const paperKind = scope === "public" ? "announcement" : "duty";
  const first = await f.draft(kind, scope === "public" ? "案内" : "当番表", scope, { text: "試しの配布本文です。", items: [] });
  await f.publish(first, scope);
  const paperPath = (row: typeof first) => `${f.admin}/print/${f.project.projectId}/${row.document_id}/${row.version_no}/${paperKind}`;
  expect(await renameProject(env.DB, f.ward.wardId, f.project.projectId, "直した行事名")).toBe(true);
  const original = await get(realApp, paperPath(first), f.cookie);
  expect(original.status).toBe(200);
  const originalHtml = await original.text();
  expect(originalHtml).toContain(f.project.title);
  expect(originalHtml).not.toContain("直した行事名");

  const second = await f.draft(kind, scope === "public" ? "案内" : "当番表", scope, { text: "試しの次の配布本文です。", items: [] });
  const preview = await get(realApp, `${f.admin}/print/${f.project.projectId}/${second.document_id}/${second.version_no}/preview`, f.cookie);
  expect(preview.status).toBe(200);
  expect(await preview.text()).toContain("直した行事名");
  await f.publish(second, scope);
  expect(await (await get(realApp, paperPath(second), f.cookie)).text()).toContain("直した行事名");
  expect(await env.DB.prepare("SELECT project_title FROM document_versions WHERE ward_id = ? AND version_id = ?")
    .bind(f.ward.wardId, second.version_id).first<string>("project_title")).toBe("直した行事名");

  // 以前の記録や古い写しから戻した記録にも、変更前の題を残す。
  await env.DB.prepare("UPDATE document_versions SET project_title = NULL WHERE ward_id = ? AND version_id = ?")
    .bind(f.ward.wardId, second.version_id).run();
  expect(await renameProject(env.DB, f.ward.wardId, f.project.projectId, "もう一度直した題")).toBe(true);
  const legacyPaper = await (await get(realApp, paperPath(second), f.cookie)).text();
  expect(legacyPaper).toContain("直した行事名");
  expect(legacyPaper).not.toContain("もう一度直した題");
  expect(await (await get(realApp, paperPath(first), f.cookie)).text()).toContain(f.project.title);

  if (scope === "space") {
    // 本文を作り直さず、表だけ変えて配り直したときも、新しい配布の題を保存する。
    expect((await applyChange(env.DB, f.ward.wardId, f.project.projectId, {
      kind: "row", table: "duties", data: { slot: "試しの午前", assignee: "試しの担当" },
      source: { kind: "person", accountId: f.account.accountId }, confidence: "high", packVersion: "fictional-consistency@1",
    })).status).toBe("applied");
    await f.publish(second, scope);
    const third = await env.DB.prepare("SELECT version_no, project_title FROM document_versions WHERE ward_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 1")
      .bind(f.ward.wardId, second.document_id).first<{ version_no: number; project_title: string }>();
    expect(third!.version_no).toBe(second.version_no + 1);
    expect(third!.project_title).toBe("もう一度直した題");
  }
});

it("答える画面とエラー後の画面は、別の募集ではなく知らせた案内と同じ手伝いの時間帯を出す", async () => {
  const f = await fixture();
  const times = ["設営9時〜10時", "受付10時〜11時"];
  const announcement = await f.draft("announcement", "案内", "public", { text: "試しの案内です。", items: [{ key: "helper_slots", content: times.join("、") }] });
  await f.publish(announcement, "public");
  const recruitment = await f.draft("recruitment", "別の手伝いの募集", "public", {
    text: "別の試しの募集です。", items: [{ key: "helper_slots", content: "片付け15時〜16時" }],
  });
  await f.publish(recruitment, "public");
  const paper = await (await get(realApp, `${f.admin}/print/${f.project.projectId}/${announcement.document_id}/${announcement.version_no}/answer`, f.cookie)).text();
  for (const time of times) expect(paper).toContain(time);
  const path = `${f.base}/answer/${f.project.projectId}`;
  const form = await (await get(realApp, path)).text();
  for (const time of times) expect(form).toContain(`value="${time}"`);
  expect(form).not.toContain('value="片付け15時〜16時"');
  const invalid = await postForm(realApp, path, { household: "", helper_name: "試しの手伝いさん", helper_times: times[0]! });
  expect(invalid.status).toBe(400);
  const retry = await invalid.text();
  for (const time of times) expect(retry).toContain(`value="${time}"`);
  expect(retry).not.toContain('value="片付け15時〜16時"');

  const next = await f.draft("announcement", "案内", "public", { text: "時間帯がまだ決まっていない試しの案内です。", items: [{ key: "helper_slots", content: "（確認中）" }] });
  // 下書きを直しただけでは、配った案内の選択肢は変わらない。
  for (const time of times) expect(await (await get(realApp, path)).text()).toContain(`value="${time}"`);
  await f.publish(next, "public");
  const withoutTimes = await (await get(realApp, path)).text();
  expect(withoutTimes).toContain('id="times" name="helper_times" type="text"');
  expect(withoutTimes).not.toContain('value="片付け15時〜16時"');
  expect(withoutTimes).not.toContain('value="（確認中）"');
});

it("知らせの確認は紙と住民向けのページと同じ本文を出し、古い項目を足し戻さない", async () => {
  const f = await fixture();
  const notice = await f.draft("notice", "変更のお知らせ", "public", {
    text: "会場を試しの新会場に変更します。", items: [{ key: "place", content: "試しの旧会場" }],
  });
  const preview = await get(realApp, `${f.admin}/publish/${f.project.projectId}/confirm?kind=notice`, f.cookie);
  expect(preview.status).toBe(200);
  const html = await preview.text();
  expect(html).toContain("試しの新会場");
  expect(html).not.toContain("試しの旧会場");
  await f.publish(notice, "public");
  const paper = await (await get(realApp, `${f.admin}/print/${f.project.projectId}/${notice.document_id}/${notice.version_no}/announcement`, f.cookie)).text();
  const page = await (await get(realApp, `${f.base}/p/${f.project.projectId}`)).text();
  for (const rendered of [paper, page]) {
    const body = rendered.slice(rendered.indexOf("<body"));
    expect(body).toContain("試しの新会場");
    expect(body).not.toContain("試しの旧会場");
  }
});
