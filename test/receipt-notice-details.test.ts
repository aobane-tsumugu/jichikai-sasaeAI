import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary, type DocumentKind } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it.each(["event", "general_meeting"] as const)("%sの受付結果は知らせに残った古い会場を足さず、下げた後は知らせた案内へ戻る", async (kind) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind, title: "試しの会場変更確認会", year: 2099, accountId: account.accountId });
  const root = `/${ward.slug}`;
  const oldPlace = "試しの変更前の会館";
  const oldRain = "試しの変更前の雨の対応";
  const times = "9時から10時";
  const publish = async (documentKind: DocumentKind, text: string) => {
    const current = await getProjectSummary(env.DB, ward.wardId, project.projectId);
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: documentKind, title: "試しの配布文書", scope: "public", basedOn: current!.stateVersion,
      body: JSON.stringify({ text, items: [
        { key: "place", content: oldPlace }, { key: "rain_plan", content: oldRain }, { key: "helper_slots", content: times },
      ] }),
    })).toBe(true);
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId, documentKind).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!row) throw new Error("試しの配布文書がありません。");
    expect((await postForm(realApp, `${root}/admin/publish/${project.projectId}/send`, {
      documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
    return row.document_id;
  };
  await publish("announcement", "試しの案内です。");
  if (kind === "event") await publish("recruitment", "試しの準備を手伝ってください。");
  const answer = {
    household: "試しの代表", district: "", adults_count: "1", meeting_status: "attend", submission_id: crypto.randomUUID(),
  };
  const receipts = async () => {
    const responses = [await postForm(realApp, `${root}/answer/${project.projectId}`, answer)];
    if (kind === "event") responses.push(await postForm(realApp, `${root}/help/${project.projectId}`, {
      helper_name: "試しの手伝いさん", helper_times: times, submission_id: "fictional-notice-help-receipt",
    }));
    const html: string[] = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      html.push(await response.text());
    }
    return html;
  };
  for (const html of await receipts()) expect(html).toContain(oldPlace);
  const noticeId = await publish("notice", "会場を試しの新しい集会室へ変えました。雨でも同じ場所です。");
  for (const html of await receipts()) {
    expect(html).not.toContain(oldPlace);
    expect(html).not.toContain(oldRain);
    expect(html).toContain("日時や場所は案内で確かめてください。");
    expect(html).toContain(`href="${root}/p/${project.projectId}"`);
  }
  const record = await env.DB.prepare(`SELECT publication_id FROM publication_records
    WHERE ward_id = ? AND project_id = ? AND document_id = ? AND unpublished_at IS NULL`)
    .bind(ward.wardId, project.projectId, noticeId).first<{ publication_id: string }>();
  if (!record) throw new Error("試しの知らせの配布記録がありません。");
  expect((await postForm(realApp, `${root}/admin/publish/${project.projectId}/lower/${record.publication_id}`, {}, cookie)).status).toBe(303);
  for (const html of await receipts()) {
    expect(html).toContain(oldPlace);
    expect(html).toContain(oldRain);
    expect(html).not.toContain("日時や場所は案内で確かめてください。");
  }
});
