import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectSummary } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { WARD_DESCRIPTION as fixture } from "./fixtures/ward-description";
import { get, postForm, realApp } from "./helpers";

it("開いている行事だけの区で案内を配り、説明を一項目ずつ載せ、下げても下書きから戻せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const root = `/${ward.slug}`;
  const close = `${root}/admin/close/${project.projectId}`;
  const work = `${root}/work/${project.projectId}`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };

  // 説明がなくても、普段の案内は配れる。
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: FIRST_SLICE.draftTitle, scope: "public", basedOn: 0,
    body: JSON.stringify({ text: FIRST_SLICE.publicAnnouncement, items: [] }),
  })).toBe(true);
  const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1")
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("試しの案内がありません。");
  const notice = await postForm(realApp, `${root}/admin/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    recipientScope: "all_households", distribution: JSON.stringify({ mode: "district", targets: [{ district: "全戸", copies: 12 }] }),
  }, cookie);
  expect(notice.status).toBe(303);
  expect(await read(`${root}/p/${project.projectId}`)).toContain(FIRST_SLICE.publicAnnouncement);
  expect(await read(`${root}/`)).not.toContain(work);

  const entry = `${root}/admin/close/activity`;
  expect(await read(`${root}/admin/settings`)).toContain(`href="${entry}"`);
  expect(await read(entry)).toContain(`href="${close}?view=activity"`);
  const editor = await read(`${close}?view=activity`);
  expect(editor).toContain('name="action" value="publish"');
  expect(editor).toMatch(/name="membershipBenefit"[^>]*><\/textarea>/);
  expect(editor).not.toContain("載せるときに必要です");

  const publish = async (fields: Record<string, string>) => {
    const response = await postForm(realApp, `${close}/activity`, { action: "publish", ...fields }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("activity=published");
  };
  await publish({ introduction: " ", membershipBurden: fixture.burden, membershipBenefit: " " });
  let page = await read(work);
  expect(page).toContain(fixture.burden);
  expect(page).not.toContain("加入すると得られること");
  expect(page).not.toContain("仕事の記録から作りました");
  expect(page).not.toContain("この項目の説明はありません");
  let home = await read(`${root}/`);
  expect(home).toContain(`href="${work}"`);
  expect(home).toContain("加入すると担うこと");
  expect(home).not.toContain("加入すると得られること");

  // 保存だけでは載せた説明を変えない。空欄にした項目も、載せ直すと消える。
  const benefitOnly = { introduction: "", membershipBurden: "", membershipBenefit: fixture.benefit };
  expect((await postForm(realApp, `${close}/activity`, { action: "save", ...benefitOnly }, cookie)).status).toBe(303);
  expect(await read(work)).toContain(fixture.burden);
  expect(await read(work)).not.toContain(fixture.benefit);
  await publish(benefitOnly);
  page = await read(work);
  expect(page).toContain(fixture.benefit);
  expect(page).not.toContain("加入すると担うこと");
  expect(page).not.toContain(fixture.burden);

  await publish({ introduction: fixture.introduction, membershipBurden: "", membershipBenefit: "" });
  page = await read(work);
  expect(page).toContain(fixture.introduction);
  expect(page).not.toContain("加入すると担うこと");
  expect(page).not.toContain("加入すると得られること");
  expect(await read(`${close}?view=activity`)).toContain('name="action" value="unpublish"');
  const lowered = await postForm(realApp, `${close}/activity`, { action: "unpublish" }, cookie);
  expect(lowered.status).toBe(303);
  const resultPath = lowered.headers.get("location");
  if (!resultPath) throw new Error("説明を下げたあとの戻り先がありません。");
  expect(await read(resultPath)).toContain("もう一度載せられます");
  expect((await get(realApp, work)).status).toBe(404);
  home = await read(`${root}/`);
  expect(home).not.toContain(work);
  expect(await read(`${root}/p/${project.projectId}`)).toContain(FIRST_SLICE.publicAnnouncement);
  expect(await read(`${close}?view=activity`)).toContain(fixture.introduction);
  await publish({ introduction: fixture.introduction });
  expect(await read(work)).toContain(fixture.introduction);
  expect((await getProjectSummary(env.DB, ward.wardId, project.projectId))?.closedAt).toBeNull();
  const jobs = await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ count: number }>();
  expect(jobs?.count).toBe(0);
});
