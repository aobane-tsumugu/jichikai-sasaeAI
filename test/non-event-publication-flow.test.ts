import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { documentTitle, paperHeading } from "../src/project/heading";
import type { DocumentKind, Scope } from "../src/project/model";
import { createInvite } from "../src/space/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

// 資料、名前、合言葉はfixturesの架空の入力だけを使う。
it("総会と役員会を種類に合う題で読み、当番の知らせは実行委員と班長へ配り、総会の答えを同じ順で見る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const base = `/${ward.slug}`;
  const admin = `${base}/admin`;
  const save = async (projectId: string, basedOn: number, kind: DocumentKind, scope: Scope, text: string) => {
    expect(await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
      kind, scope, title: documentTitle("event", kind), basedOn,
      body: JSON.stringify({ text, items: [{ key: "content", content: text }] }),
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, projectId, kind).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("架空の下書きがありません。");
    return { documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip" };
  };
  const read = async (path: string, credentials?: string) => {
    const response = await get(realApp, path, credentials);
    expect(response.status).toBe(200);
    return response.text();
  };
  const meeting = await createProject(env.DB, ward.wardId, {
    kind: "general_meeting", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const board = await createProject(env.DB, ward.wardId, {
    kind: "board_meeting", title: FIRST_SLICE.draftTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const event = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.draftTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  for (const [project, projectKind, kind] of [
    [meeting, "general_meeting", "announcement"], [meeting, "general_meeting", "report"],
    [board, "board_meeting", "report"], [event, "event", "announcement"],
  ] as const) {
    const form = await save(project.projectId, project.stateVersion, kind, "public", FIRST_SLICE.publicAnnouncement);
    expect((await postForm(realApp, `${admin}/publish/${project.projectId}/send`, form, cookie)).status).toBe(303);
    const html = await read(`${base}/p/${project.projectId}`);
    if (projectKind === "event") {
      expect(html).toContain(`<h1>${project.title}のご案内</h1>`);
      expect(html).toContain("<h2>くわしい案内</h2>");
    } else {
      const title = documentTitle(projectKind, kind);
      expect(html).toContain(kind === "announcement" ? "<h2>くわしい案内</h2>" : `<h2>${title}</h2>`);
      expect(html).not.toContain(`<h1>${project.title}のご案内</h1>`);
      expect(await read(`${base}/`)).toContain(`<b>${paperHeading(project.title, title)}</b>`);
    }
  }
  const duty = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: FIRST_SLICE.dutyTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const id = duty.projectId;
  const space = `${base}/space/${id}`;
  expect((await postForm(realApp, `${admin}/space/${id}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const entered = await postForm(realApp, `${space}/enter`, { passphrase: FIRST_SLICE.passphrase });
  const memberCookie = cookieFrom(entered, `space_${id}`);
  const token = await createInvite(env.DB, ward.wardId, id, "leader", FIRST_SLICE.district, account.accountId, true);
  const leaderCookie = cookieFrom(await get(realApp, `${space}/person/${token}`), `space_${id}`);
  if (!memberCookie || !leaderCookie) throw new Error("架空の実行委員と班長が入れません。");
  const notice = await save(id, duty.stateVersion, "notice", "space", FIRST_SLICE.dutyText);
  expect(await read(space, memberCookie)).not.toContain(FIRST_SLICE.dutyText);
  const confirmation = await read(`${admin}/publish/${id}/confirm?kind=notice`, cookie);
  expect(confirmation).toContain(`action="${admin}/publish/${id}/space"`);
  expect(confirmation).toContain(FIRST_SLICE.dutyText);
  expect(confirmation).toContain("実行委員と班長に配ります。区のページには載りません。");
  expect(confirmation).not.toContain('name="lineDelivery" value="send"');
  expect((await postForm(realApp, `${admin}/publish/${id}/space`, notice, cookie)).status).toBe(303);
  const changed = await save(id, duty.stateVersion, "notice", "space", FIRST_SLICE.previousMaterial);
  for (const credentials of [memberCookie, leaderCookie]) {
    const html = await read(space, credentials);
    expect(html).toContain(FIRST_SLICE.dutyText);
    expect(html).not.toContain(FIRST_SLICE.previousMaterial);
  }
  expect((await postForm(realApp, `${admin}/publish/${id}/space`, changed, cookie)).status).toBe(303);
  for (const credentials of [memberCookie, leaderCookie]) {
    const html = await read(space, credentials);
    expect(html).toContain(FIRST_SLICE.previousMaterial);
    expect(html).not.toContain(FIRST_SLICE.dutyText);
  }
  expect((await postForm(realApp, `${admin}/publish/${id}/send`, changed, cookie)).status).toBe(404);
  expect((await get(realApp, `${base}/p/${id}`)).status).toBe(404);
  for (const path of [`${base}/`, space]) {
    const html = await read(path);
    expect(html).not.toContain(FIRST_SLICE.dutyText);
    expect(html).not.toContain(FIRST_SLICE.previousMaterial);
  }
  const publication = await env.DB.prepare("SELECT COUNT(*) AS count FROM publication_records WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, id).first<{ count: number }>();
  expect(publication?.count).toBe(0);
  const answers = `${admin}/answers/${meeting.projectId}`;
  const empty = await read(answers, cookie);
  expect(empty).toContain("まだ答えはありません");
  expect(empty).toContain(`href="${answers}?view=send"`);
  await replaceRoster(env.DB, ward.wardId, [FIRST_SLICE.firstHousehold, FIRST_SLICE.secondHousehold]
    .map((household) => ({ household, district: FIRST_SLICE.district })), { household: 0, district: 1 });
  expect((await postForm(realApp, `${answers}/phone`, {
    household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, meeting_status: "proxy", proxy_name: FIRST_SLICE.firstOfficer,
  }, cookie)).status).toBe(303);
  const summary = await read(answers, cookie);
  expect(summary).toContain('class="answers-wide"');
  expect(summary).toMatch(/<div class="counts space-counts"><div class="count"><b>1<small>世帯<\/small><\/b><span>\d+世帯のうち/);
  const rows = summary.match(/<ul class="rows two">([\s\S]*?)<\/ul>/)?.[1];
  if (!rows) throw new Error("総会の答えの操作がありません。");
  const paths = [`${answers}?view=unanswered`, `${answers}?view=hand`, `${answers}?view=list`, `${answers}?view=read`, `${admin}/answers/roster`];
  let previous = -1;
  for (const path of paths) {
    const position = rows.indexOf(`href="${path}"`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
});
