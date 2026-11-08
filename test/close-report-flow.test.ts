import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import * as ai from "../src/ai/api";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack } from "../src/draft/packs";
import { getEditableDocument, saveAIDraft, saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary } from "../src/project/api";
import { get, postForm, realApp, sendLatest } from "./helpers";

it("文の報告を閉じて残し、直して知らせ直し、五つの種類は既存の指示と範囲で閉じる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  const projectId = project.projectId;
  expect(await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
    kind: "report", title: fixture.draftTitle, scope: "public", basedOn: 0,
    body: JSON.stringify({ text: fixture.reportText, items: [{ key: "content", content: fixture.reportText }] }),
  })).toBe(true);
  const document = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect(document).not.toBeNull();
  expect((await postForm(realApp, `${root}/publish/${projectId}/send`, {
    documentId: document!.document_id, versionId: document!.version_id, versionNo: String(document!.version_no),
    lineDelivery: "skip", distribution: "",
  }, cookie)).status).toBe(303);
  const before = await getEditableDocument(env.DB, ward.wardId, projectId, "report");
  const close = `${root}/close/${projectId}`;
  // 報告は終わりにする前に、ほかの連絡と同じ送り方で送ってある（L-319）。終わりにする画面は送ったことだけを書く。
  expect(await (await get(realApp, close, cookie)).text()).toContain("に住民に送りました。");
  expect((await postForm(realApp, `${close}/finalize`, {}, cookie)).status).toBe(303);
  expect((await getProjectSummary(env.DB, ward.wardId, projectId))?.closedAt).toBeTruthy();
  expect(await getEditableDocument(env.DB, ward.wardId, projectId, "report")).toEqual(before);
  expect(await (await get(realApp, `/${ward.slug}/p/${projectId}`)).text()).toContain(fixture.reportText);
  expect(await (await get(realApp, `${root}/print/${projectId}/${document!.document_id}/${document!.version_no}/announcement`, cookie)).text()).toContain(fixture.reportText);
  expect((await get(realApp, `${root}/photos/${projectId}`, cookie)).status).toBe(404);
  expect((await get(realApp, `/${ward.slug}/photos/${projectId}/fictional-photo`)).status).toBe(404);

  // 終わりを取り消して報告を直し、送り直してから閉じ直すと、新しい報告が載る。
  expect((await postForm(realApp, `${close}/reopen`, {}, cookie)).status).toBe(303);
  const edited = `${fixture.reportText}\n${fixture.nextYearChange}`;
  expect(await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
    kind: "report", title: fixture.draftTitle, scope: "public", basedOn: (await getProjectSummary(env.DB, ward.wardId, projectId))!.stateVersion,
    body: JSON.stringify({ text: edited, items: [{ key: "content", content: fixture.reportText }] }),
  })).toBe(true);
  expect((await sendLatest(ward.slug, ward.wardId, projectId, "report", cookie)).status).toBe(303);
  expect((await postForm(realApp, `${close}/finalize`, {}, cookie)).status).toBe(303);
  const after = await getEditableDocument(env.DB, ward.wardId, projectId, "report");
  expect(after!.versionId).not.toBe(before!.versionId);
  expect(JSON.parse(after!.body)).toMatchObject({ text: edited });
  expect(await (await get(realApp, `/${ward.slug}/p/${projectId}`)).text()).toContain(fixture.nextYearChange);

  const started: ai.StartTaskInput[] = [];
  const fake = vi.spyOn(ai, "startTask").mockImplementation(async (target, _ctx, task) => {
    started.push(task);
    if (task.task === "report") {
      const summary = await getProjectSummary(target.DB, task.wardId, task.projectId);
      if (!summary) throw new Error("試しの仕事がありません");
      const pack = getDraftPack("report", summary.kind);
      expect(task.instruction).toContain(pack.instruction);
      expect(task.instruction).toContain(`範囲: ${pack.scope}`);
      expect(task.instruction).toContain(`pack_versionを${pack.version}`);
      expect(task.instruction).not.toContain("住民に向けた公開の報告だけを書きます");
      expect(await saveAIDraft(target.DB, task.wardId, task.projectId, "report", pack.version, {
        title: pack.title, scope: pack.scope, text: fixture.reportText,
        items: [{ key: "content", content: fixture.reportText }], based_on_state_version: summary.stateVersion,
      })).toBe(true);
    }
    return "fictional-close-job";
  });
  try {
    for (const [kind, expected, scope] of [
      ["general_meeting", "総会の議事録を作ります", "staff"],
      ["board_meeting", "役員会の議事録を作ります", "staff"],
      ["duty", "作業の報告を作ります", "public"],
      ["city_request", "市へ提出する回答の下書きを作ります", "staff"],
      ["request", "提出する要望書の下書きを作ります", "staff"],
    ] as const) {
      const work = await createProject(env.DB, ward.wardId, { kind, title: fixture.draftTitle,
        year: fixture.eventYear, accountId: account.accountId });
      const path = `${root}/close/${work.projectId}`;
      expect((await postForm(realApp, `${path}/prepare`, {}, cookie)).status).toBe(303);
      expect(started.find(task => task.projectId === work.projectId && task.task === "report")?.instruction).toContain(expected);
      const page = await (await get(realApp, path, cookie)).text();
      // 住民向けの報告は、終わりにする画面に欄を置かず、下書きがあることと送る道だけを書く（L-319）。
      expect(page).toContain(scope === "public" ? "報告の下書きがあります。まだ住民に送っていません。" : fixture.reportText);
      if (scope === "staff") {
        expect(page).toContain(`${getDraftPack("report", kind).title}（役員だけ）`);
        expect(page).not.toContain('id="report-public"');
        expect(page).not.toContain("報告が住民向けのページに載ります");
      }
      // 下書きは追加の保存操作なしでも閉じた記録へ残る。
      expect((await postForm(realApp, `${path}/finalize`, {}, cookie)).status).toBe(303);
      expect((await getProjectSummary(env.DB, ward.wardId, work.projectId))?.closedAt).toBeTruthy();
      expect(await getEditableDocument(env.DB, ward.wardId, work.projectId, "report")).toMatchObject({ scope });
      const published = await env.DB.prepare("SELECT COUNT(*) AS n FROM publication_records WHERE ward_id = ? AND project_id = ?")
        .bind(ward.wardId, work.projectId).first<number>("n");
      // 終わりにする処理では配らない。住民への報告は、送る前の確かめの画面から送る。
      expect(published).toBe(0);
    }
    expect(started.filter(task => task.task === "report")).toHaveLength(5);
    expect(started.filter(task => task.task === "map_draft")).toHaveLength(5);
  } finally { fake.mockRestore(); }
});
