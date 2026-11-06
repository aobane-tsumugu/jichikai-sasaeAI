import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("資料のない一年目に案内を手で保存し、出欠の入口と当番が0件の紙を読める", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const id = project.projectId;
  const materialsResponse = await get(realApp, `${root}/projects/${id}`, cookie);
  expect(materialsResponse.status).toBe(200);
  const materials = await materialsResponse.text();
  expect(materials).toContain("届いた資料を見る");
  expect(materials).toContain("まだ資料は入っていません。");
  expect(materials).toContain("質問はありません");
  expect(materials).toContain("下書きの一覧を開く");

  const dutyDraft = await (await get(realApp, `${root}/projects/${id}/draft/duty_roster`, cookie)).text();
  expect(dutyDraft).toContain("実行委員と班長に見せる当番表です。直して保存しても、まだ配られません。");
  expect(dutyDraft).toContain("当番表の説明");
  expect(dutyDraft).toContain("当番表の行はまだありません。");
  const recruitment = await (await get(realApp, `${root}/projects/${id}/draft/recruitment`, cookie)).text();
  expect(recruitment).toContain("区のページの「一回だけ手伝う」に出る募集です。");
  expect(recruitment).toContain("募集の文");
  expect(recruitment).toContain("申し込みの締切");

  const saved = await postForm(realApp, `${root}/projects/${id}/draft/announcement/save`, {
    title: "案内", scope: "public", based_on: String(project.stateVersion),
    text: `${FIRST_SLICE.publicAnnouncement}\n持ち物：（確認中）`,
    item_date_time: FIRST_SLICE.publicDayText, item_place: FIRST_SLICE.previousPlace,
  }, cookie);
  expect(saved.status).toBe(303);
  const savedLocation = saved.headers.get("location");
  if (!savedLocation) throw new Error("保存後の行き先がありません");
  const savedPage = await (await get(realApp, savedLocation, cookie)).text();
  expect(savedPage).toContain("保存しました。まだ配っていません");
  expect(savedPage).toContain("配る画面へ");
  expect(savedPage).toContain("前の下書きに戻す");

  const draft = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement' ORDER BY v.version_no DESC LIMIT 1`)
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!draft) throw new Error("保存した案内がありません");
  const fields = { documentId: draft.document_id, versionId: draft.version_id, versionNo: String(draft.version_no), lineDelivery: "skip" };
  const confirmation = await postForm(realApp, `${root}/publish/${id}/confirm`, fields, cookie);
  expect(confirmation.status).toBe(200);
  const confirmPage = await confirmation.text();
  expect(confirmPage).toContain(`この下に「出欠を答える」のボタンが出ます。`);
  expect(confirmPage).toContain("まだ決めていないところがあります");
  expect(confirmPage).toContain("紙とページから外して配ります。");
  expect(confirmPage).toContain("下書きに戻る");
  const sent = await postForm(realApp, `${root}/publish/${id}/send`, fields, cookie);
  expect(sent.status).toBe(303);
  const publicPage = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
  expect(publicPage).toContain(`href="/${ward.slug}/answer/${id}">出欠を答える</a>`);
  const paper = await get(realApp, `${root}/print/${id}/${draft.document_id}/${draft.version_no}/duty`, cookie);
  expect(paper.status).toBe(200);
  const paperPage = await paper.text();
  expect(paperPage).toContain(`${FIRST_SLICE.nextYearTitle} 当番表と配置図`);
  expect(paperPage).toContain(FIRST_SLICE.publicDayText);
  expect(paperPage).toContain(FIRST_SLICE.previousPlace);
  expect(paperPage).toContain("当番はまだありません。");
  expect(paperPage).not.toContain("配置はまだありません。");
  expect(paperPage).toContain("変わったこと、メモ");
});
