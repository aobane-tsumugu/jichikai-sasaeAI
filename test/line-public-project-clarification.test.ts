import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listClarifications, processPhotoBatches, registerLinePhoto } from "../src/line/clarifications";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { postForm, realApp, withEnv } from "./helpers";

it("行事を聞く候補は住民向けのページに知らせたものに限り、候補なしでも同じ質問を送る", async () => {
  const owner = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const { ward, account } = owner;
  const now = new Date("2026-11-06T01:00:00Z");
  const runtime = withEnv({ LINE_CHANNEL_ACCESS_TOKEN: "fictional-project-question-token" });
  const destination = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding)
    VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')`).bind(ward.wardId, destination).run();

  const draft = async (admin: typeof owner, title: string, scope: "public" | "space") => {
    const project = await createProject(env.DB, admin.ward.wardId, {
      kind: "event", title, year: fixture.eventYear, accountId: admin.account.accountId,
    });
    expect(await saveDocument(env.DB, admin.ward.wardId, project.projectId, admin.account.accountId, {
      kind: scope === "public" ? "announcement" : "procedure", title: fixture.draftTitle, scope, basedOn: 0,
      body: JSON.stringify({ text: fixture.publicAnnouncement, items: [{ key: "date_time", content: fixture.publicDayText }] }),
    })).toBe(true);
    const row = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
      WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
      .bind(admin.ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!row) throw new Error("試しの下書きがありません");
    return { project, row };
  };
  const publish = async (admin: typeof owner, data: Awaited<ReturnType<typeof draft>>, scope: "public" | "space") => {
    expect((await postForm(realApp, `/${admin.ward.slug}/admin/publish/${data.project.projectId}/${scope === "public" ? "send" : "space"}`, {
      documentId: data.row.document_id, versionId: data.row.version_id, versionNo: String(data.row.version_no), lineDelivery: "skip",
    }, admin.cookie)).status).toBe(303);
  };
  const publicEvent = await draft(owner, fixture.nextYearTitle, "public");
  await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const spaceEvent = await draft(owner, fixture.dutyTitle, "space");
  await publish(owner, spaceEvent, "space");
  const otherEvent = await draft(other, fixture.reportText, "public");
  await publish(other, otherEvent, "public");

  type Message = { text: string; quoteToken?: string; quickReply?: { items: Array<{ action: { label: string; data: string } }> } };
  const sent: Array<{ to: string; messages: Message[] }> = [];
  const fakeLine: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (path.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (!path.endsWith("/message/push")) throw new Error("試験にないLINE呼び出しです");
    sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
    return Response.json({ sentMessages: [{ id: `fictional-project-question-${sent.length}` }] });
  };
  const ask = async (index: number) => {
    const result = await receive(runtime, { wardId: ward.wardId, via: "line_direct", parts: [{
      kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg",
      bytes: new Uint8Array([...fixture.answerSheetPhotoBytes, index]),
    }] });
    const original = result.received[0];
    if (!result.jobId || !original) throw new Error("試しの写真を受け取れていません");
    const reading: Reading = {
      document_kind: "photo", summary: fixture.reportText,
      original_years: [{ original_id: original.originalId, year: fixture.eventYear }],
      text_blocks: [{ original_id: original.originalId, locator: "全体", text: fixture.reportText }],
      fields: [{ name: "日時", value: fixture.publicDayText, confidence: "high", original_id: original.originalId, locator: "上" }],
      tables: [], decisions: [], unreadable: [],
    };
    await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
      VALUES (?, ?, ?, 'model', 'read-general@3', 'claude-sonnet-5-5', ?, ?)`)
      .bind(crypto.randomUUID(), ward.wardId, result.jobId, JSON.stringify(reading), now.toISOString()).run();
    await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?")
      .bind(now.toISOString(), ward.wardId, result.jobId).run();
    const sender = `fictional-project-sender-${index}`;
    const batchId = await registerLinePhoto(env.DB, ward.wardId, {
      destination, source: { type: "user", id: sender, senderId: sender }, jobId: result.jobId,
      messageId: `fictional-project-photo-${index}`, quoteToken: `fictional-project-quote-${index}`,
      now: new Date(now.getTime() - 11 * 60_000),
    });
    // 行事を当て終えても不明だった写真から、問い返しを通す。
    await env.DB.prepare("UPDATE line_photo_batches SET match_finished_at = ? WHERE ward_id = ? AND batch_id = ?")
      .bind(now.toISOString(), ward.wardId, batchId).run();
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent).toHaveLength(index);
    const message = sent[index - 1];
    expect(message?.to).toBe(sender);
    expect(message?.messages).toHaveLength(1);
    expect(message?.messages[0]?.text).toBe("この写真は、どれの資料ですか？");
    expect(message?.messages[0]?.quoteToken).toBe(`fictional-project-quote-${index}`);
    const questions = await listClarifications(env.DB, ward.wardId, batchId);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.topic).toBe("project");
    expect(questions[0]?.sent_at).toBe(now.toISOString());
    return { question: questions[0]!, message: message!.messages[0]! };
  };

  let aiCalls = 0;
  setClientFactory(() => { aiCalls++; throw new Error("行事を聞く文にAIは使いません"); });
  try {
    const before = await ask(1);
    expect(before.question.options).toHaveLength(0);
    expect(before.message.quickReply).toBeUndefined();

    await publish(owner, publicEvent, "public");
    const after = await ask(2);
    expect(after.question.options).toEqual([publicEvent.project.title]);
    expect(after.message.quickReply?.items.map((item) => item.action.label)).toEqual([publicEvent.project.title]);

    await env.DB.prepare("UPDATE publication_records SET unpublished_at = ? WHERE ward_id = ? AND project_id = ?")
      .bind(now.toISOString(), ward.wardId, publicEvent.project.projectId).run();
    const lowered = await ask(3);
    expect(lowered.question.options).toHaveLength(0);
    expect(lowered.message.quickReply).toBeUndefined();
    expect(aiCalls).toBe(0);
    expect(await env.DB.prepare("SELECT SUM(push_recipients) AS n FROM line_photo_batches WHERE ward_id = ?")
      .bind(ward.wardId).first<number>("n")).toBe(3);
  } finally { setClientFactory(null); }
});
