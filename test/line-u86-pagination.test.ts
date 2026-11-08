import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listOriginals } from "../src/intake/store";
import { saveAiBundleDecision } from "../src/line/bundle-decisions";
import { registerLinePhoto } from "../src/line/clarifications";
import { saveOfficerDecision } from "../src/line/talk-edits";
import { conversationFor, listTalks, talkPath, type TalkTopic } from "../src/line/talks";
import { recordLineInquiry } from "../src/project/followup";
import { get, postForm, realApp } from "./helpers";

// この試験の文章、名前、LINEの接続先と送信元は全て。
const destination = "fictional-u86-destination";
const group = "fictional-u86-group";
const sender = "fictional-u86-sender";

async function seedTopics(via: "admin" | "line_group") {
  const admin = await seedAdmin(env.DB);
  for (let index = 0; index < 50; index++) {
    const at = new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString();
    const text = `試しの話題${String(index + 1).padStart(2, "0")}です。`;
    const received = await receive(env, { wardId: admin.ward.wardId, accountId: admin.account.accountId, via,
      parts: [{ kind: "text", filename: "試しの説明.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
    if (!received.jobId) throw new Error("試しの話題を受け付けられませんでした");
    await env.DB.prepare("UPDATE jobs SET created_at = ?, status = 'done' WHERE ward_id = ? AND job_id = ?")
      .bind(at, admin.ward.wardId, received.jobId).run();
    const bundle = via === "admin" ? `admin:${received.jobId}` : `fictional-u86-${index}`;
    if (via === "line_group") await env.DB.prepare(`INSERT INTO line_inbox_items
      (ward_id, item_id, event_id, job_id, sender_id, sender_display_name, source_type, source_id,
        line_destination, original_kind, original_text, received_at, bundle_id)
      VALUES (?, ?, ?, ?, ?, '試しの役員', 'group', ?, ?, 'text', ?, ?, ?)`)
      .bind(admin.ward.wardId, received.jobId, `fictional-u86-event-${index}`, received.jobId,
        sender, group, destination, text, at, bundle).run();
    await saveAiBundleDecision(env.DB, admin.ward.wardId, bundle, text, "material", null, new Date());
  }
  const talk = (await listTalks(env.DB, admin.ward.wardId))[0];
  if (!talk) throw new Error("試しのトークがありません");
  expect(talk.topics).toHaveLength(50);
  return { ...admin, talk, root: `/${admin.ward.slug}/admin`, path: `/${admin.ward.slug}/admin${talkPath(talk.id)}` };
}

function expectTopics(html: string, topics: TalkTopic[]) {
  expect(html.match(/class="talk-topic"/g)).toHaveLength(topics.length);
  let previous = -1;
  for (const topic of topics) {
    const position = html.indexOf(`id="${topic.anchor}"`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
}

function olderLink(html: string) {
  const href = html.match(/href="([^"]+)">それより前の話題を見る<\/a>/)?.[1];
  if (!href) throw new Error("それより前の話題へのリンクがありません");
  return href;
}

async function expectOrigin(path: string, cookie: string, anchor: string) {
  const response = await get(realApp, path, cookie);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(`id="${anchor}"`);
  expect(html.match(/class="talk-topic"/g)?.length).toBeLessThanOrEqual(20);
  return html;
}

it("U86: 役員の50話題を20ずつ古い順に出し、終わった準備が220あってもHTMLを膨らませない", async () => {
  const { ward, cookie, talk, root, path } = await seedTopics("admin");
  const activeId = crypto.randomUUID();
  const closedIds = Array.from({ length: 220 }, () => crypto.randomUUID());
  await env.DB.batch([env.DB.prepare("INSERT INTO projects (ward_id, project_id, kind, title, year) VALUES (?, ?, 'event', '試しの準備中の集まり', 2026)")
    .bind(ward.wardId, activeId), ...closedIds.map((id, index) => env.DB.prepare(`INSERT INTO projects
      (ward_id, project_id, kind, title, year, closed_at) VALUES (?, ?, 'event', ?, 2025, '2025-11-01T00:00:00Z')`)
    .bind(ward.wardId, id, `試しの終わった集まり${index}`))]);
  const latestTopic = talk.topics[49]!;
  // 今の行き先が終わったものでも、判断の名前は読み、選択肢には出さない。
  await saveOfficerDecision(env.DB, ward.wardId, latestTopic.id, "試しの保存済みの資料です。", "material", closedIds[0]!);
  const response = await get(realApp, path, cookie);
  expect(response.status).toBe(200);
  const latest = await response.text();
  expectTopics(latest, talk.topics.slice(30));
  expect(latest).not.toContain(`id="${talk.topics[29]!.anchor}"`);
  expect(latest).toContain("if(!location.hash)");
  expect(latest).toContain("scrollIntoView()");
  expect(latest).toContain("試しの終わった集まり0の資料にしました。");
  expect(latest.match(new RegExp(`value="${activeId}"`, "g"))).toHaveLength(20);
  for (const id of closedIds) expect(latest).not.toContain(`value="${id}"`);
  // 20枠と準備中の選択肢で収まる大きさ。全話題や終わった準備の反復を検出する。
  expect(new TextEncoder().encode(latest).byteLength).toBeLessThan(250_000);
  const secondPath = olderLink(latest);
  expect(secondPath).toBe(`${path}?before=${talk.topics[30]!.anchor}`);
  const second = await (await get(realApp, secondPath, cookie)).text();
  expectTopics(second, talk.topics.slice(10, 30));
  const oldestPath = olderLink(second);
  expect(oldestPath).toBe(`${path}?before=${talk.topics[10]!.anchor}`);
  const oldest = await (await get(realApp, oldestPath, cookie)).text();
  expectTopics(oldest, talk.topics.slice(0, 10));
  expect(oldest).not.toContain("それより前の話題を見る");
  const first = talk.topics[0]!;
  const jobId = first.posts[0]!.jobId;
  if (!jobId) throw new Error("元の受付がありません");
  const origin = await conversationFor(env.DB, ward.wardId, { jobId });
  expect(origin).toBe(`${talkPath(talk.id)}?before=${talk.topics[10]!.anchor}#${first.anchor}`);
  if (!origin) throw new Error("元の会話への道がありません");
  await expectOrigin(root + origin, cookie, first.anchor);
  const old = await get(realApp, `${root}/inbox/city/${jobId}/pick`, cookie);
  expect(old.status).toBe(303);
  expect(old.headers.get("location")).toBe(root + origin);
  const changed = await postForm(realApp, `${path}/topics/${first.anchor.slice(6)}`, {
    action: "unrelated", summary: "試しの送信を直しました。",
  }, cookie);
  expect(changed.status).toBe(303);
  const changedPath = changed.headers.get("location");
  if (!changedPath) throw new Error("直したあとの送り先がありません");
  expect(changedPath).toContain(`?before=${talk.topics[10]!.anchor}&n=changed&at=`);
  await expectOrigin(changedPath, cookie, first.anchor);
  expect((await get(realApp, `${path}?before=topic-unknown`, cookie)).status).toBe(404);
  const other = await seedAdmin(env.DB);
  expect((await get(realApp, `/${other.ward.slug}/admin${origin}`, other.cookie)).status).toBe(404);
  expect(await conversationFor(env.DB, other.ward.wardId, { jobId })).toBeNull();
});

it("U86: 20より前のLINEの話題へ、問い合わせと古いURLと質問への回答から戻れる", async () => {
  const { ward, cookie, talk, root, path } = await seedTopics("line_group");
  const first = talk.topics[0]!;
  const inquiryTopic = talk.topics[1]!;
  const post = first.posts[0]!;
  if (!post.jobId || !post.itemId) throw new Error("試しの届いたものがありません");
  await recordLineInquiry(env.DB, ward.wardId, { eventId: inquiryTopic.posts[0]!.eventId!,
    receivedAt: inquiryTopic.posts[0]!.at, text: "試しの集まりの場所を教えてください。",
    sourceType: "group", sourceId: group, senderLabel: "試しの役員" });
  await env.DB.prepare("UPDATE inquiry_records SET line_bundle_id = ? WHERE ward_id = ? AND line_event_id = ?")
    .bind(inquiryTopic.id, ward.wardId, inquiryTopic.posts[0]!.eventId).run();
  await saveAiBundleDecision(env.DB, ward.wardId, inquiryTopic.id, "試しの場所への問い合わせです。", "inquiry", null, new Date());
  const inquiry = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
    .bind(ward.wardId, inquiryTopic.id).first<{ inquiry_id: string }>();
  if (!inquiry) throw new Error("試しの問い合わせがありません");
  const origin = `${talkPath(talk.id)}?before=${talk.topics[10]!.anchor}#${inquiryTopic.anchor}`;
  expect(await conversationFor(env.DB, ward.wardId, { inquiryId: inquiry.inquiry_id })).toBe(origin);
  const reply = await (await get(realApp, `${root}/inquiries/${inquiry.inquiry_id}`, cookie)).text();
  expect(reply).toContain(`href="${root}${origin}"`);
  expect(reply).toContain("元の会話を見る");
  await expectOrigin(root + origin, cookie, inquiryTopic.anchor);
  const originals = await listOriginals(env.DB, ward.wardId, post.jobId);
  const original = originals[0];
  if (!original) throw new Error("試しの元の資料がありません");
  const batch = await registerLinePhoto(env.DB, ward.wardId, { destination,
    source: { type: "group", id: group, senderId: sender }, jobId: post.jobId,
    messageId: "fictional-u86-message", now: new Date(post.at) });
  const clarification = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO line_clarifications
    (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options)
    VALUES (?, ?, ?, ?, ?, 'unreadable', '試しの時刻を教えてください。', '["分からない"]')`)
    .bind(ward.wardId, clarification, batch, post.jobId, original.original_id).run();
  const firstOrigin = `${path}?before=${talk.topics[10]!.anchor}#${first.anchor}`;
  for (const oldPath of [`${root}/inbox/questions`, `${root}/inbox/${post.itemId}/pick`]) {
    const old = await get(realApp, oldPath, cookie);
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe(firstOrigin);
    await expectOrigin(firstOrigin, cookie, first.anchor);
  }
  const answered = await postForm(realApp, `${root}/inbox/questions/${clarification}`, { answer: "午後二時" }, cookie);
  expect(answered.status).toBe(303);
  const answerPath = answered.headers.get("location");
  expect(answerPath).toBe(`${path}?before=${talk.topics[10]!.anchor}&n=answered&at=${first.anchor.slice(6)}#${first.anchor}`);
  if (!answerPath) throw new Error("答えを残したあとの道がありません");
  expect(await expectOrigin(answerPath, cookie, first.anchor)).toContain("答えを残しました。");
  const latest = await (await get(realApp, path, cookie)).text();
  expectTopics(latest, talk.topics.slice(30));
  const second = await (await get(realApp, olderLink(latest), cookie)).text();
  expectTopics(second, talk.topics.slice(10, 30));
  const oldest = await (await get(realApp, olderLink(second), cookie)).text();
  expectTopics(oldest, talk.topics.slice(0, 10));
  for (const html of [latest, second, oldest]) {
    expect(html).not.toContain(group);
    expect(html).not.toContain(destination);
  }
});
