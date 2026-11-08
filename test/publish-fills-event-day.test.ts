import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary } from "../src/project/api";
import { postForm, realApp } from "./helpers";

async function publishAnnouncement(slug: string, wardId: string, projectId: string, accountId: string, cookie: string, dateTime: string) {
  await saveDocument(env.DB, wardId, projectId, accountId, { kind: "announcement", title: "案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "年末の見回りを行います。", items: [{ key: "date_time", content: dateTime }] }) });
  const doc = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? ORDER BY v.version_no DESC LIMIT 1`).bind(wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect((await postForm(realApp, `/${slug}/admin/publish/${projectId}/send`, { documentId: doc!.document_id, versionId: doc!.version_id, versionNo: String(doc!.version_no), recipientScope: "member_households", lineDelivery: "skip" }, cookie)).status).toBe(303);
}

it("前提 3: 知らせた案内の「いつ」から当日と終わる日が読めれば、準備の当日が空の時だけ入れる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const patrol = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2030, accountId: account.accountId });
  await publishAnnouncement(ward.slug, ward.wardId, patrol.projectId, account.accountId, cookie, "12月26日（木）から28日（土）まで、毎晩午後8時から");
  expect((await getProjectSummary(env.DB, ward.wardId, patrol.projectId))?.deadlines).toMatchObject({ event_day: "2030-12-26", event_end: "2030-12-28" });

  // 役員が入れた当日は書き換えない
  const set = await createProject(env.DB, ward.wardId, { kind: "event", title: "新年会", year: 2030, accountId: account.accountId, eventDay: "2030-01-12" });
  await publishAnnouncement(ward.slug, ward.wardId, set.projectId, account.accountId, cookie, "2030年2月1日（金）");
  expect((await getProjectSummary(env.DB, ward.wardId, set.projectId))?.deadlines.event_day).toBe("2030-01-12");

  // 過ぎた日（去年の日が残った案内）は入れない
  const old = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の清掃", year: 2020, accountId: account.accountId });
  await publishAnnouncement(ward.slug, ward.wardId, old.projectId, account.accountId, cookie, "2020年11月1日（日）");
  expect((await getProjectSummary(env.DB, ward.wardId, old.projectId))?.deadlines.event_day).toBeUndefined();
});
