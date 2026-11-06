import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { callTool } from "../src/ai/mcp";
import { READ_PACK_VERSION } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { sha256Hex } from "../src/core/password";
import { getDraftPack, listDraftPacks } from "../src/draft/packs";
import { draftMaterials } from "../src/draft/materials";
import { buildDirectReading } from "../src/intake/direct-reading";
import { receive } from "../src/intake/receive";
import { getEditableDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { replaceRoster } from "../src/answers/api";
import { paperHeading } from "../src/project/heading";
import type { DocumentKind, ProjectKind, Scope } from "../src/project/model";
import { get, postForm, realApp } from "./helpers";

// AIの起動だけ止め、受付、読み取りの保存、MCP、下書き、紙、公開は実際の処理を使う。
vi.mock("../src/ai/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ai/session")>(),
  dispatchProject: vi.fn(async () => {}),
}));

it("総会、役員会、当番、市の依頼、要望の仕事から資料と下書きへ進み、紙と同じ内容を残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const cases: { kind: Exclude<ProjectKind, "event">; tasks: Record<string, DocumentKind>; main: DocumentKind; title: string; scope: Scope }[] = [
    { kind: "general_meeting", tasks: { agenda: "procedure", notice: "announcement", minutes: "report" }, main: "report", title: "議事録", scope: "staff" },
    { kind: "board_meeting", tasks: { agenda: "procedure", minutes: "report" }, main: "report", title: "議事録", scope: "staff" },
    { kind: "duty", tasks: { assign: "duty_roster", notify: "notice" }, main: "duty_roster", title: "当番表", scope: "space" },
    { kind: "city_request", tasks: { reply: "procedure", submit: "report" }, main: "report", title: "提出する回答", scope: "staff" },
    { kind: "request", tasks: { content: "procedure", submit: "report" }, main: "report", title: "要望書", scope: "staff" },
  ];
  const unrelated = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.nextYearTitle, year: fixture.sourceYear });
  await receive(env, { wardId: ward.wardId, projectId: unrelated.projectId, via: "admin", parts: [
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(fixture.previousMaterial) },
  ] });
  for (const entry of cases) {
    const project = await createProject(env.DB, ward.wardId, { kind: entry.kind, title: `${fixture.nextYearTitle} ${entry.kind}`, year: fixture.eventYear, accountId: account.accountId });
    const id = project.projectId; const path = `${root}/projects/${id}`;
    const state = await getProjectState(env.DB, ward.wardId, id);
    if (!state) throw new Error("架空の仕事を作れませんでした");
    const read = async (url: string) => {
      const response = await get(realApp, url, cookie);
      expect(response.status).toBe(200);
      return response.text();
    };
    const mapHtml = await read(`${path}/map`);
    for (const task of state.mapTasks) {
      expect(task.taskKey).not.toBeNull();
      const key = task.taskKey!;
      if (key === "answers") {
        expect(mapHtml).toContain(`${root}/answers/${id}`);
        continue; // 答えの中身はU33の担当。
      }
      expect(mapHtml).toContain(`${path}/map/${task.taskId}`);
      const taskHtml = await read(`${path}/map/${task.taskId}`);
      const kind = entry.tasks[key];
      if (kind) {
        const pack = getDraftPack(kind, entry.kind);
        expect(taskHtml).toContain(`${path}/draft/${kind}`);
        expect(taskHtml).toContain(`${pack.title}の下書きを直す`);
        const draft = await read(`${path}/draft/${kind}`);
        expect(draft).toContain(`name="title" value="${pack.title}"`);
        const scopeInput = draft.match(/<input\b[^>]*>/g)?.find((tag) => tag.includes('name="scope"') && tag.includes(`value="${pack.scope}"`));
        expect(scopeInput).toBeDefined();
        expect(scopeInput).toMatch(kind === "duty_roster" ? /type="hidden"/ : /checked/);
        expect(draft).not.toContain('id="rain-form"');
        if (kind === "procedure") expect(pack.scope).toBe("staff");
      } else {
        const materialUrl = `${root}/intake?project=${id}#send-form`;
        expect(taskHtml).toContain(materialUrl);
        await read(materialUrl);
      }
    }
    expect(listDraftPacks(entry.kind)).toHaveLength(6);
    expect(getDraftPack("notice", "duty").scope).toBe("space");
    const text = `${fixture.eventYear}年\n${fixture.reportText.repeat(230)}\n${fixture.requestedBy}`;
    const received = await receive(env, { wardId: ward.wardId, projectId: id, via: "admin", accountId: account.accountId, parts: [
      { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(text) },
      { kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) },
    ] });
    const photo = received.received.find((original) => original.kind === "photo");
    if (!received.jobId || !photo) throw new Error("架空の紙と文を受け付けられませんでした");
    // 写真を読んだ応答だけを架空の読み取りに置き換える。文は受付が直接読んだもの。
    const reading = buildDirectReading([{ originalId: photo.originalId, text: `${fixture.eventYear}年\n${fixture.reportText}\n${fixture.requestedBy}` }]);
    await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
      VALUES (?, ?, ?, 'model', ?, 'fictional-model', ?, ?)`)
      .bind(crypto.randomUUID(), ward.wardId, received.jobId, READ_PACK_VERSION.general, JSON.stringify(reading), new Date().toISOString()).run();
    const material = await draftMaterials(env.DB, ward.wardId, id);
    expect(material).toContain(photo.originalId);
    expect(material).toContain(fixture.requestedBy);
    expect(material).not.toContain(fixture.previousMaterial);
    const pack = getDraftPack(entry.main, entry.kind);
    expect(pack).toMatchObject({ title: entry.title, scope: entry.scope });
    expect(pack.version).not.toBe(getDraftPack(entry.main).version);
    if (entry.main === "report" && ["general_meeting", "board_meeting"].includes(entry.kind)) {
      expect(pack.instruction).toContain("推測で決定、発言、出席、可決を足しません");
      expect(pack.instruction).toContain("名簿や去年の出席者から補いません");
      expect(await read(`${path}/draft/report`)).toContain("紙や文を送る");
    }
    if (entry.kind === "duty") {
      await replaceRoster(env.DB, ward.wardId, [{ household: fixture.requestedBy, district: fixture.district }], { household: 0, district: 1 });
      expect((await applyChange(env.DB, ward.wardId, id, {
        kind: "row", table: "duties", data: { slot: fixture.publicDayText, task: fixture.helperTime, assignee: fixture.requestedBy },
        source: { kind: "original", ref: photo.originalId, locator: "1行目", year: fixture.sourceYear },
        confidence: "high", packVersion: "non-event-duty-fixture@1",
      })).status).toBe("applied");
    }
    const ctx = createExecutionContext();
    const started = await realApp.fetch(new Request(`http://localhost${path}/draft/${entry.main}/start`, {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: "instruction=",
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(started.status).toBe(303);
    if (entry.kind === "duty") {
      expect(started.headers.get("location")).toContain("notice=saved");
      const prepared = await getProjectState(env.DB, ward.wardId, id);
      expect(prepared?.tables.duties.filter((row) => row.scope === "current")).toMatchObject([
        { data: { slot: fixture.publicDayText, assignee: fixture.requestedBy }, source: { kind: "ai_proposal" } },
      ]);
      expect(await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'")
        .bind(ward.wardId, id).first()).toBeNull();
      expect((await postForm(realApp, `${path}/draft/${entry.main}/save`, {
        title: pack.title, scope: pack.scope, text: fixture.reportText, based_on: String(prepared?.project.stateVersion),
      }, cookie)).headers.get("location")).toContain("notice=saved");
    } else {
      expect(started.headers.get("location")).toContain("notice=started");
      const job = await env.DB.prepare(`SELECT job_id, instruction FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'`)
        .bind(ward.wardId, id).first<{ job_id: string; instruction: string }>();
      if (!job) throw new Error("下書きの依頼がありません");
      expect(job.instruction.length).toBeGreaterThan(4000);
      expect(job.instruction).toContain(material);
      expect(job.instruction).toContain(`対象の文書: ${entry.main}。範囲: ${entry.scope}。`);
      const ticket = `tk_${crypto.randomUUID()}`;
      await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND project_id = ? AND job_id = ?")
        .bind(await sha256Hex(ticket), ward.wardId, id, job.job_id).run();
      const result = await callTool(env, ward.wardId, "write_change", {
        ticket, kind: "draft", target: entry.main, confidence: "high", data: {
          title: pack.title, scope: pack.scope, text: fixture.reportText,
          items: [{ key: "content", content: fixture.reportText, source: photo.originalId }],
          pack_version: pack.version, based_on_state_version: state.project.stateVersion,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "applied" });
    }
    const saved = await getEditableDocument(env.DB, ward.wardId, id, entry.main);
    expect(saved).toMatchObject({ title: pack.title, scope: pack.scope });
    const latest = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ? AND version_id = ?`)
      .bind(ward.wardId, id, saved?.versionId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!latest) throw new Error("下書きが保存されていません");
    const paper = await read(`${root}/print/${id}/${latest.document_id}/${latest.version_no}/preview`);
    expect(paper).toContain(paperHeading(project.title, pack.title));
    expect(paper).toContain(fixture.reportText);
    expect(paper).not.toContain('class="answer-slip"');
    if (entry.main === "report") {
      const after = await getProjectState(env.DB, ward.wardId, id);
      expect(after?.items).toEqual(state.items);
      expect(after?.tables.decisions).toEqual(state.tables.decisions);
      expect((await get(realApp, `/${ward.slug}/p/${id}`)).status).toBe(404);
    }
    if (entry.kind === "general_meeting") {
      // 役員が自分で公開に変えて配る。本文は保存したものを紙とWebの両方で使う。
      expect((await postForm(realApp, `${path}/draft/report/save`, {
        title: pack.title, scope: "public", based_on: String(state.project.stateVersion), text: fixture.reportText,
      }, cookie)).status).toBe(303);
      const publicDraft = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d JOIN document_versions v
        ON v.ward_id = d.ward_id AND v.document_id = d.document_id WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'report' ORDER BY v.version_no DESC LIMIT 1`)
        .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
      if (!publicDraft) throw new Error("公開に変えた下書きがありません");
      expect((await postForm(realApp, `${root}/publish/${id}/send`, {
        documentId: publicDraft.document_id, versionId: publicDraft.version_id, versionNo: String(publicDraft.version_no), lineDelivery: "skip",
      }, cookie)).status).toBe(303);
      const web = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
      expect(web).toContain(`<h2>${pack.title}</h2>`);
      expect(web).toContain(fixture.reportText);
    }
  }
  expect(getDraftPack("announcement").version).toBe("draft-announcement@9");
  expect(getDraftPack("announcement").instruction).toContain("住民向けの行事案内");
});
