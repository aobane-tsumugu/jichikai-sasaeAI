import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { recordLineInquiry } from "../src/project/followup";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

async function lineItem(wardId: string, itemId: string, text: string | null) {
  await env.DB.prepare(`INSERT INTO line_inbox_items (ward_id, item_id, event_id, sender_id, original_kind, original_text, received_at, disposition)
    VALUES (?, ?, ?, 'fictional-sender', ?, ?, '2026-09-10T00:00:00.000Z', 'unmatched')`).bind(wardId, itemId, `event-${itemId}`, text ? "text" : "image", text).run();
}

it("届いたものが無い時は、知らせと次にすることだけを出す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const page = await (await get(realApp, `/${ward.slug}/admin/inbox`, cookie)).text();
  expect(page).toContain("届いたものはありません");
  expect(page).toContain("資料を送る");
  expect(page).toContain("← 最初の画面へ");
  expect(page).not.toContain("どの行事か分からないもの");
  expect(page).not.toContain("行事に入れたもの");
  expect(page).not.toContain("ありません。</p></section>");
});

it("分からないものは行事を選ぶ画面へ進み、選び直しと外した時を正しく知らせる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId });
  await lineItem(ward.wardId, "item-1", "架空の連絡");
  const inbox = await (await get(realApp, `${root}/inbox`, cookie)).text();
  expect(inbox).toContain("「架空の連絡」");
  expect(inbox).toContain(`href="${root}/inbox/item-1/pick"`);
  expect(inbox).not.toContain("<select");
  const pick = await (await get(realApp, `${root}/inbox/item-1/pick`, cookie)).text();
  expect(pick).toContain("どれの資料にしますか");
  expect(pick).toContain("架空の行事");
  expect(pick).toContain("この中にない");
  expect(pick).toContain("この名前で新しく準備を始める");
  expect(pick).not.toContain("関係のないものとして捨てる");
  expect((await postForm(realApp, `${root}/inbox/item-1`, { operation: "assign", projectId: "" }, cookie)).headers.get("location")).toContain("error=input");
  expect((await postForm(realApp, `${root}/inbox/item-1`, { operation: "new-project", projectName: "", kind: "event", year: "2026" }, cookie)).headers.get("location")).toContain("error=input");
  expect((await get(realApp, `${root}/inbox/none/pick`, cookie)).status).toBe(404);
});

it("問い合わせは二件と残りの件数を出し、問い合わせの画面へつなぐ", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  for (const [index, text] of ["明日の架空の集まりは何時からですか", "架空の質問その二", "架空の質問その三", "架空の質問その四"].entries()) {
    await recordLineInquiry(env.DB, ward.wardId, { eventId: `inquiry-${index}`, receivedAt: `2026-09-1${index}T00:00:00.000Z`, text: text!, sourceType: "user", sourceId: "fictional-user", senderLabel: null });
  }
  const page = await (await get(realApp, `/${ward.slug}/admin/inbox`, cookie)).text();
  expect(page).toContain("「明日の架空の集まりは何時からですか」");
  expect(page).toContain("急ぎかもしれません（「明日」とあります）。");
  expect(page).toContain("ほかの問い合わせ 2件");
  expect(page).not.toContain("架空の質問その二");
  expect(page).toContain(`/${ward.slug}/admin/inquiries/`);
});
