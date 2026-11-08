import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { senderNumbers, senderText } from "../src/line/sender";
import { listTalks, talkPath } from "../src/line/talks";
import { recordLineInquiry } from "../src/project/followup";
import { get, realApp } from "./helpers";

// 名前、文、ID、時刻は全て。実際のLINEへの通信は行わない。
const first = "fictional-u88-first";
const second = "fictional-u88-second";
const named = "fictional-u88-named";
const namedText = "試しの名前のある人";
const firstAlias = "個別に送ってきた方 1";
const secondAlias = "個別に送ってきた方 2";

async function inbox(wardId: string, eventId: string, senderId: string, at: string, name: string | null = null) {
  await env.DB.prepare(`INSERT INTO line_inbox_items
    (ward_id, item_id, event_id, sender_id, sender_display_name, sender_label, source_type, source_id,
      line_destination, original_kind, original_text, received_at, bundle_id)
    VALUES (?, ?, ?, ?, ?, 'LINE個別', 'user', ?, 'fictional-u88-destination', 'text', ?, ?, ?)`)
    .bind(wardId, eventId, eventId, senderId, name, senderId, `試しの連絡です（${eventId}）。`, at, eventId).run();
}

async function page(path: string, cookie: string) {
  const response = await get(realApp, path, cookie);
  expect(response.status).toBe(200);
  return response.text();
}

it("U88: 同じ人の届いたものと問い合わせを同じ番号で見分け、名前のある人は名前で読む", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  // 保存した順ではなく、問い合わせも含めた最初の受信時刻で番号を決める。
  await inbox(ward.wardId, "fictional-u88-second-1", second, "2026-11-01T08:01:00.000Z");
  await inbox(ward.wardId, "fictional-u88-first-1", first, "2026-11-01T08:02:00.000Z");
  await inbox(ward.wardId, "fictional-u88-named-1", named, "2026-11-01T07:00:00.000Z", namedText);
  await recordLineInquiry(env.DB, ward.wardId, { eventId: "fictional-u88-question", receivedAt: "2026-11-01T08:00:00.000Z",
    text: "試しの集まりの開始時刻を教えてください。", sourceType: "user", sourceId: first, senderLabel: null });
  let talks = await listTalks(env.DB, ward.wardId);
  expect(talks).toHaveLength(3);
  expect(talks.find((talk) => talk.posts.some((post) => post.senderId === first))?.name).toBe(firstAlias);
  expect(talks.find((talk) => talk.posts.some((post) => post.senderId === second))?.name).toBe(secondAlias);

  // 二通目が届いたあとも、同じ番号のまま。
  await inbox(ward.wardId, "fictional-u88-second-2", second, "2026-11-01T08:03:00.000Z");
  // 同じ人がグループで送った文は、送り方だけを変えて同じ番号にする。
  await env.DB.prepare(`INSERT INTO line_talk_inquiry_posts
    (ward_id, event_id, bundle_id, destination, source_type, source_id, sender_id, sender_name, received_at, text)
    VALUES (?, 'fictional-u88-group-post', 'fictional-u88-group-bundle', 'fictional-u88-destination',
      'group', 'fictional-u88-group', ?, NULL, '2026-11-01T08:04:00.000Z', '試しのグループの連絡です。')`)
    .bind(ward.wardId, second).run();
  talks = await listTalks(env.DB, ward.wardId);
  expect(talks).toHaveLength(4);
  const list = await page(`${root}/inbox`, cookie);
  for (const text of [firstAlias, secondAlias, `${namedText}さん`]) expect(list).toContain(`<b>${text}</b>`);
  for (const talk of talks) {
    const html = await page(`${root}${talkPath(talk.id)}`, cookie);
    if (talk.posts[0]?.sourceType === "group") {
      expect(html).toContain("<strong>グループで送ってきた方 2</strong>");
    } else {
      expect(html).toContain(`<h1>${talk.name}</h1>`);
      const expected = talk.posts[0]?.senderId === second ? secondAlias
        : talk.posts[0]?.senderId === first ? firstAlias : `${namedText}さん`;
      expect(html.match(new RegExp(`<strong>${expected}</strong>`, "g"))).toHaveLength(talk.posts.length);
    }
    expect(html).not.toContain("名前の分からない人");
    expect(html).not.toContain("LINEの名前を取れなかった");
    expect(html).not.toContain(`${firstAlias}さん`);
    expect(html).not.toContain(`${secondAlias}さん`);
  }
  const inquiry = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?")
    .bind(ward.wardId, "fictional-u88-question").first<{ inquiry_id: string }>();
  if (!inquiry) throw new Error("試しの問い合わせがありません");
  for (const path of ["/inquiries", `/inquiries/${inquiry.inquiry_id}`, `/inquiries/${inquiry.inquiry_id}/original`, "/", "/projects/today"]) {
    const html = await page(`${root}${path}`, cookie);
    expect(html).toContain(firstAlias);
    expect(html).not.toContain(`${firstAlias}さん`);
    expect(html).not.toContain(first);
    expect(html).not.toContain(second);
  }
  // 画面を開いても仮名は保存せず、元の名前なしを保つ。
  expect(await env.DB.prepare("SELECT sender_display_name FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
    .bind(ward.wardId, "fictional-u88-second-2").first()).toEqual({ sender_display_name: null });
  expect(await env.DB.prepare("SELECT line_sender_label FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?")
    .bind(ward.wardId, inquiry.inquiry_id).first()).toEqual({ line_sender_label: null });
  const publicPage = await page(`/${ward.slug}/`, cookie);
  for (const text of [firstAlias, secondAlias, namedText, first, second]) expect(publicPage).not.toContain(text);
});

it("U88: 三つの記録を利用者IDでまとめ、同時刻と自治会の境界でも番号をそろえる", async () => {
  const { ward } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const at = "2026-11-01T08:00:00.000Z";
  // 同時刻は、別々の表にあっても利用者ID順。同じIDの重複は一人。
  await inbox(ward.wardId, "fictional-u88-c-inbox", "fictional-u88-c", at);
  await recordLineInquiry(env.DB, ward.wardId, { eventId: "fictional-u88-b-inquiry", receivedAt: at,
    text: "試しのグループからの質問です。", sourceType: "group", sourceId: "fictional-u88-group",
    userId: "fictional-u88-b", senderLabel: "LINEグループ" });
  await env.DB.prepare(`INSERT INTO line_talk_inquiry_posts
    (ward_id, event_id, bundle_id, destination, source_type, source_id, sender_id, sender_name, received_at, text)
    VALUES (?, 'fictional-u88-a-post', 'fictional-u88-a-bundle', 'fictional-u88-destination', 'room',
      'fictional-u88-room', 'fictional-u88-a', NULL, ?, '試しの複数人の連絡です。')`)
    .bind(ward.wardId, at).run();
  await inbox(ward.wardId, "fictional-u88-a-later", "fictional-u88-a", "2026-11-02T08:00:00.000Z");
  await inbox(other.ward.wardId, "fictional-u88-c-other", "fictional-u88-c", "2026-10-01T08:00:00.000Z");
  expect([...(await senderNumbers(env.DB, ward.wardId))]).toEqual([
    ["fictional-u88-a", 1], ["fictional-u88-b", 2], ["fictional-u88-c", 3],
  ]);
  expect([...(await senderNumbers(env.DB, other.ward.wardId))]).toEqual([["fictional-u88-c", 1]]);
  const talks = await listTalks(env.DB, ward.wardId);
  const group = talks.find((talk) => talk.posts.some((post) => post.id.startsWith("inquiry:")));
  expect(group?.posts[0]).toMatchObject({ senderId: "fictional-u88-b", senderNumber: 2 });
  expect(senderText(group?.posts[0]?.sender, "group", group?.posts[0]?.senderNumber)).toBe("グループで送ってきた方 2");
  expect(senderText("   ", "room", 1)).toBe("グループで送ってきた方 1");
});
