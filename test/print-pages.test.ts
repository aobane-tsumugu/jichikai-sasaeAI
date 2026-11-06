import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

describe("印刷用ページ", () => {
  it("案内の下書きから配った紙まで、市の依頼と要望には回答票を付けず、行事と総会には残す", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const root = `/${ward.slug}/admin`;
    const read = async (path: string) => {
      const response = await get(realApp, path, cookie);
      expect(response.status).toBe(200);
      return response.text();
    };
    for (const entry of [
      { kind: "city_request", answer: false }, { kind: "request", answer: false },
      { kind: "event", answer: true }, { kind: "general_meeting", answer: true },
    ] as const) {
      const project = await createProject(env.DB, ward.wardId, {
        kind: entry.kind, title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId,
      });
      expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
        kind: "announcement", title: fixture.draftTitle, scope: "public", basedOn: 0,
        body: JSON.stringify({ text: fixture.draftText, items: [{ key: "due", content: fixture.eventDay }] }),
      })).toBe(true);
      const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
        WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, project.projectId)
        .first<{ document_id: string; version_id: string; version_no: number }>();
      if (!version) throw new Error("印刷する下書きがありません。");
      const listPath = `${root}/print/${project.projectId}`;
      const path = `${listPath}/${version.document_id}/${version.version_no}`;
      const draftList = await read(listPath);
      expect(draftList.includes(`href="${path}/preview?paper=answer"`)).toBe(entry.answer);
      const draft = await read(`${path}/preview`);
      expect(draft).toContain(fixture.draftText);
      expect(draft.includes('class="answer-slip"')).toBe(entry.answer);
      if (!entry.answer) expect(draft.match(/class="sheet"/g)).toHaveLength(1);

      expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
        documentId: version.document_id, versionId: version.version_id,
        versionNo: String(version.version_no), lineDelivery: "skip",
      }, cookie)).status).toBe(303);
      const list = await read(listPath);
      const chooser = await read(path);
      expect(list).toContain(`href="${path}/poster"`);
      expect(chooser).toContain(`href="${path}/poster"`);
      for (const html of [list, chooser]) {
        expect(html.includes(`href="${path}/answer"`)).toBe(entry.answer);
        expect(html.includes(`href="${path}/leader"`)).toBe(entry.answer);
        expect(html.includes("案内と回答票")).toBe(entry.answer);
      }
      const paper = await read(`${path}/announcement`);
      expect(paper).toContain(fixture.draftText);
      expect(paper.includes('class="answer-slip"')).toBe(entry.answer);
      if (!entry.answer) expect(paper.match(/class="sheet"/g)).toHaveLength(1);
      if (entry.answer) expect(paper).toContain(entry.kind === "general_meeting" ? "委任する相手" : "参加する人数");
      const poster = await read(`${path}/poster`);
      expect(poster).toContain("区のページを開くQR");
      expect(poster.includes("答えの締切：")).toBe(entry.answer);
      expect(poster.includes("答えてください")).toBe(entry.answer);
      for (const kind of ["answer", "leader"]) {
        expect((await get(realApp, `${path}/${kind}`, cookie)).status).toBe(entry.answer ? 200 : 404);
      }
    }
  });

  it("当番表と配置図の紙は、案内の本文ではなく今年の当番と配置から作る", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    const source = { kind: "person" as const, accountId: account.accountId };
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data: { slot: "9:00〜10:30", task: "設営", assignee: "架空 当番さん" }, source, confidence: "high", packVersion: "print-test@1",
    });
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "layout", data: { spot: "受付", position: "玄関の右" }, source, confidence: "high", packVersion: "print-test@1",
    });
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "架空の案内", scope: "public", body: JSON.stringify({ text: "案内だけに書いた架空の本文", items: [] }), basedOn: 0,
    });
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id WHERE d.ward_id = ? AND d.project_id = ?`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("配る案内がありません。");
    expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);

    const base = `/${ward.slug}/admin/print/${project.projectId}/${version!.document_id}/${version!.version_no}`;
    const duty = await (await get(realApp, `${base}/duty`, cookie)).text();
    expect(duty).toContain("架空 当番さん");
    expect(duty).toContain("玄関の右");
    expect(duty).not.toContain("案内だけに書いた架空の本文");
    const announcement = await (await get(realApp, `${base}/announcement`, cookie)).text();
    expect(announcement).toContain("案内だけに書いた架空の本文");
  });
});
