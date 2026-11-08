import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { receive } from "../src/intake/receive";
import { listOriginals } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { recordLineInquiry } from "../src/project/followup";
import { getBundleDecision, saveAiBundleDecision } from "../src/line/bundle-decisions";
import { registerLinePhoto } from "../src/line/clarifications";
import { createLineIntakePorts } from "../src/line/intake";
import { conversationFor, listTalks, talkPath } from "../src/line/talks";
import { get, postForm, realApp } from "./helpers";
import { U83_TALKS as fixture } from "./fixtures/line-u83-talks";

it("U83: トーク、参考への直し、AIの上書き防止、分割と戻す、写真への答え、問い合わせからの往復を通す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.project, year: 2026, accountId: account.accountId });
  const photo = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "line_group", parts: [1, 2].map((tag) => ({
    kind: "photo", filename: `試しの当番表${tag}.jpg`, mediaType: "image/jpeg", bytes: new Uint8Array([...FIRST_SLICE.answerSheetPhotoBytes, tag]),
  })) });
  if (!photo.jobId) throw new Error("試しの写真が受け付けられませんでした");
  const words = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "line_group", parts: [{
    kind: "text", filename: "試しの説明.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(fixture.words),
  }] });
  if (!words.jobId) throw new Error("試しの説明が受け付けられませんでした");
  const bundle = "fictional-u83-topic";
  for (const [jobId, eventId, kind, text, at] of [
    [photo.jobId, "fictional-u83-photo", "image", null, "2026-11-07T05:02:00.000Z"],
    [words.jobId, "fictional-u83-words", "text", fixture.words, "2026-11-07T05:05:00.000Z"],
  ] as const) {
    await env.DB.prepare(`INSERT INTO line_inbox_items (ward_id, item_id, event_id, job_id, sender_id, sender_display_name,
      source_type, source_id, line_destination, original_kind, original_text, received_at, bundle_id, matched_project_id)
      VALUES (?, ?, ?, ?, ?, ?, 'group', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ward.wardId, jobId, eventId, jobId, fixture.person, fixture.sender, fixture.group, fixture.destination, kind, text, at, bundle, project.projectId).run();
    await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?")
      .bind(at, ward.wardId, jobId).run();
  }
  await saveAiBundleDecision(env.DB, ward.wardId, bundle, fixture.summary, "material", project.projectId, new Date());
  const originals = await listOriginals(env.DB, ward.wardId, photo.jobId);
  const original = originals[0];
  if (!original?.r2_path) throw new Error("試しの写真の原本がありません");
  const batch = await registerLinePhoto(env.DB, ward.wardId, { destination: fixture.destination,
    source: { type: "group", id: fixture.group, senderId: fixture.person }, jobId: photo.jobId, messageId: "fictional-u83-message", now: new Date("2026-11-07T05:02:00Z") });
  const clarification = "fictional-u83-unreadable";
  await env.DB.prepare(`INSERT INTO line_clarifications (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options)
    VALUES (?, ?, ?, ?, ?, 'unreadable', ?, '["分からない"]')`)
    .bind(ward.wardId, clarification, batch, photo.jobId, original.original_id, fixture.question).run();
  const event = "fictional-u83-resident-question";
  await recordLineInquiry(env.DB, ward.wardId, { eventId: event, receivedAt: "2026-11-07T05:10:00Z", text: fixture.inquiry,
    sourceType: "user", sourceId: fixture.resident, senderLabel: "試しの住民" });
  await env.DB.prepare("UPDATE inquiry_records SET line_bundle_id = ? WHERE ward_id = ? AND line_event_id = ?")
    .bind("fictional-u83-inquiry", ward.wardId, event).run();
  await saveAiBundleDecision(env.DB, ward.wardId, "fictional-u83-inquiry", "住民からの駐車場の質問です。", "inquiry", null, new Date());
  const talks = await listTalks(env.DB, ward.wardId);
  expect(talks).toHaveLength(2);
  const group = talks.find((t) => t.name === "役員のLINEグループ");
  if (!group) throw new Error("役員のトークがありません");
  expect(group.waiting).toBe(1);
  const topic = group.topics[0];
  if (!topic) throw new Error("写真と言葉がありません");
  const path = root + talkPath(group.id);
  const inbox = await (await get(realApp, `${root}/inbox`, cookie)).text();
  expect(inbox).toContain("役員のLINEグループ");
  expect(inbox).toContain("試しの住民");
  expect(inbox).toContain("AIから役員への質問が1つあり、まだ答えがありません。");
  expect(inbox).not.toContain("その場で直せます");
  expect(inbox).not.toContain("答えを待っている質問: ");
  expect(inbox).not.toContain(fixture.group);
  const page = await (await get(realApp, path, cookie)).text();
  expect(page.match(/class="talk-topic"/g)).toHaveLength(1);
  expect(page.match(/class="talk-post"/g)).toHaveLength(2);
  expect(page).toContain(`写真2枚と言葉: ${fixture.summary}`);
  expect(page).toContain(`→ ${fixture.project}の資料にしました。`);
  expect(page.indexOf(`originals/${original.original_id}`)).toBeLessThan(page.indexOf(fixture.question));
  expect(page.indexOf(fixture.question)).toBeLessThan(page.indexOf(fixture.words));
  expect(page).toContain("関係のない会話は残していません");
  expect(page).toContain("AIから役員への質問が1つあり、まだ答えがありません。");
  expect(page).toContain(`${topic.anchor}">AIからの質問のところへ移る</a>`);
  expect(page).not.toContain("届いた順に読めます。");
  const edit = `${path}/topics/${topic.anchor.slice(6)}`;
  const corrected = await postForm(realApp, edit, { choice: `reference:${project.projectId}`, summary: fixture.summary }, cookie);
  expect(corrected.status).toBe(303);
  expect(await getBundleDecision(env.DB, ward.wardId, bundle)).toMatchObject({ action: "reference", decided_by: "officer", project_id: project.projectId });
  await saveAiBundleDecision(env.DB, ward.wardId, bundle, "別のAIの判断", "material", null, new Date());
  const ports = createLineIntakePorts(env, { waitUntil: (promise) => { void promise; } }, async () => { throw new Error("人の直しにAIを呼んではいけません"); });
  await ports.matchInboxItem(ward.wardId, { eventId: "fictional-u83-later", senderId: fixture.person, sourceType: "group", kind: "text", text: "後から届いた文", receivedAt: new Date().toISOString(), bundleId: bundle });
  expect(await getBundleDecision(env.DB, ward.wardId, bundle)).toMatchObject({ action: "reference", decided_by: "officer", summary: fixture.summary });
  expect((await (await get(realApp, path, cookie)).text())).toContain(`→ ${fixture.project}の参考にしました。`);
  const split = await postForm(realApp, `${edit}/boundary`, { postId: words.jobId, operation: "split" }, cookie);
  expect(split.status).toBe(303);
  expect((await (await get(realApp, path, cookie)).text()).match(/class="talk-topic"/g)).toHaveLength(2);
  const undo = await env.DB.prepare("SELECT undo_id FROM line_talk_undo WHERE ward_id = ? AND talk_id = ?")
    .bind(ward.wardId, group.id).first<{ undo_id: string }>();
  if (!undo) throw new Error("戻すための内容がありません");
  expect((await postForm(realApp, `${path}/undo`, { undoId: undo.undo_id }, cookie)).status).toBe(303);
  expect((await (await get(realApp, path, cookie)).text()).match(/class="talk-topic"/g)).toHaveLength(1);
  const answer = await postForm(realApp, `${root}/inbox/questions/${clarification}`, { answer: "午後二時" }, cookie);
  expect(answer.status).toBe(303);
  expect(answer.headers.get("location")).toBe(`${path}?n=answered&at=${topic.anchor.slice(6)}#${topic.anchor}`);
  expect(await env.DB.prepare("SELECT answer FROM line_clarifications WHERE ward_id = ? AND clarification_id = ?")
    .bind(ward.wardId, clarification).first()).toEqual({ answer: "午後二時" });
  const inquiry = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?")
    .bind(ward.wardId, event).first<{ inquiry_id: string }>();
  if (!inquiry) throw new Error("問い合わせがありません");
  const origin = await conversationFor(env.DB, ward.wardId, { inquiryId: inquiry.inquiry_id });
  expect(origin).not.toBeNull();
  const reply = await (await get(realApp, `${root}/inquiries/${inquiry.inquiry_id}`, cookie)).text();
  expect(reply).toContain("元の会話を見る");
  expect(reply).toContain(`href="${root}${origin}"`);
  const old = await get(realApp, `${root}/inbox/questions`, cookie);
  expect(old.status).toBe(303);
  expect(old.headers.get("location")).toBe(`${path}#${topic.anchor}`);
  const pick = await get(realApp, `${root}/inbox/${photo.jobId}/pick`, cookie);
  expect(pick.status).toBe(303);
  expect(pick.headers.get("location")).toBe(`${path}#${topic.anchor}`);
  // 問い合わせの文も、表示だけでなく実際の参考資料に直し、同じトークで戻せる。
  const residentTalk = (await listTalks(env.DB, ward.wardId)).find((talk) => talk.topics.some((t) => t.inquiry?.inquiry_id === inquiry.inquiry_id));
  const residentTopic = residentTalk?.topics.find((t) => t.inquiry?.inquiry_id === inquiry.inquiry_id);
  if (!residentTalk || !residentTopic) throw new Error("住民からの元の会話がありません");
  const residentPath = `${root}${talkPath(residentTalk.id)}`;
  const reference = await postForm(realApp, `${residentPath}/topics/${residentTopic.anchor.slice(6)}`, {
    action: "reference", summary: "駐車場について届いた言葉です。", projectId: project.projectId,
  }, cookie);
  expect(reference.status).toBe(303);
  expect(await env.DB.prepare(`SELECT j.project_id, j.status FROM jobs j JOIN line_inbox_items i
    ON i.ward_id = j.ward_id AND i.job_id = j.job_id WHERE j.ward_id = ? AND i.event_id = ?`)
    .bind(ward.wardId, event).first()).toEqual({ project_id: project.projectId, status: "done" });
  const residentUndo = await env.DB.prepare("SELECT undo_id FROM line_talk_undo WHERE ward_id = ? AND talk_id = ?")
    .bind(ward.wardId, residentTalk.id).first<{ undo_id: string }>();
  if (!residentUndo) throw new Error("問い合わせに戻すための内容がありません");
  expect((await postForm(realApp, `${residentPath}/undo`, { undoId: residentUndo.undo_id }, cookie)).status).toBe(303);
  expect(await getBundleDecision(env.DB, ward.wardId, residentTopic.id)).toMatchObject({ action: "inquiry", decided_by: "officer" });
  expect(await conversationFor(env.DB, ward.wardId, { inquiryId: inquiry.inquiry_id })).toBe(origin);
  expect(await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path)).not.toBeNull();
  const other = await seedAdmin(env.DB);
  expect((await get(realApp, `/${other.ward.slug}/admin${talkPath(group.id)}`, other.cookie)).status).toBe(404);
  expect((await postForm(realApp, `/${other.ward.slug}/admin${talkPath(group.id)}/topics/${topic.anchor.slice(6)}`, { action: "unrelated", summary: "別の自治会" }, other.cookie)).status).toBe(404);
});

it("U83: 役員の画面の一回の送信を一つの枠で出し、関係ないへの直しも戻せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const outcome = await receive(env, { wardId: ward.wardId, accountId: account.accountId, via: "admin", parts: [
    { kind: "photo", filename: "試しの写真.jpg", mediaType: "image/jpeg", bytes: new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes) },
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("試しの役員会で決まったことです。") },
  ] });
  if (!outcome.jobId) throw new Error("役員の送信がありません");
  const talk = (await listTalks(env.DB, ward.wardId))[0];
  if (!talk?.topics[0]) throw new Error("役員の送ったものがありません");
  expect(talk.name).toBe("役員の画面から送ったもの");
  expect(talk.topics).toHaveLength(1);
  expect(talk.topics[0].posts[0]?.originals).toHaveLength(2);
  const path = `/${ward.slug}/admin${talkPath(talk.id)}`;
  const edit = `${path}/topics/${talk.topics[0].anchor.slice(6)}`;
  expect((await postForm(realApp, edit, { action: "unrelated", summary: "間違えて送った写真です。" }, cookie)).status).toBe(303);
  expect(await getBundleDecision(env.DB, ward.wardId, talk.topics[0].id)).toMatchObject({ action: "unrelated", decided_by: "officer" });
  const undo = await env.DB.prepare("SELECT undo_id FROM line_talk_undo WHERE ward_id = ? AND talk_id = ?")
    .bind(ward.wardId, talk.id).first<{ undo_id: string }>();
  if (!undo) throw new Error("戻すための内容がありません");
  expect((await postForm(realApp, `${path}/undo`, { undoId: undo.undo_id }, cookie)).status).toBe(303);
  expect(await getBundleDecision(env.DB, ward.wardId, talk.topics[0].id)).toMatchObject({ action: "material", decided_by: "officer" });
  const old = await get(realApp, `/${ward.slug}/admin/inbox/city/${outcome.jobId}/pick`, cookie);
  expect(old.status).toBe(303);
  expect(old.headers.get("location")).toBe(`${path}#${talk.topics[0].anchor}`);
});
