import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { PUBLIC_PRIVACY_NOTICE, SETTING_KEYS } from "../src/settings/keys";
import { setSetting } from "../src/settings/store";
import { get, realApp } from "./helpers";

it("設定の画面は、要約の付いたリンクでなく、今の状態を文で書き、外すと消すの前に確かめる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const page = async (path: string) => (await get(realApp, `${root}${path}`, cookie)).text();

  const alone = await page("/settings");
  expect(alone).toContain("（あなた）だけです。ほかの役員にも使ってもらうと、それぞれの手元の資料を送ってもらえます。");
  expect(alone).toContain(`href="${root}/settings/people#add">ほかの役員を足す</a>`);
  expect(alone).toContain("住民向けのページに出す自治会の連絡先が、まだ入っていません。");
  expect(alone).not.toContain("直したいものを選んでください。");
  expect(alone).not.toContain("LINEやメールをつなぎます。");

  await setSetting(env.DB, ward.wardId, SETTING_KEYS.publicContact, "自治会の窓口\n集会所の郵便受け", account.accountId);
  expect(await page("/settings")).toContain("住民向けのページには、自治会の連絡先として「自治会の窓口　集会所の郵便受け」が出ています。");

  const info = await page("/settings/info");
  expect(info.indexOf("住民向けのページに出す連絡先")).toBeLessThan(info.indexOf("個人情報の扱い"));
  expect(info).not.toContain(PUBLIC_PRIVACY_NOTICE);
  expect(info).toContain("役員のLINEグループが、まだ自治会のLINEにつながっていないので、問い合わせの通知は届きません。");
  expect(info).not.toContain("問い合わせを締める時刻");
  expect(info).toContain(`href="/${ward.slug}/privacy">住民向けのページで読む</a>`);

  const people = await page("/settings/people");
  expect(people).toContain("さんを役員から外します。");
  expect(people).not.toContain('href="#add"');

  const templates = await page("/settings/templates");
  expect(templates).toContain("日時は{日時}です。");
  expect(templates).not.toContain("日ときは");
  expect(templates).toContain("を消します。元に戻せません。続けますか？");
});

it("年間の予定を読んだあとのトップは、仮の一年と書かず、分かった予定を名前で書く", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const top = async () => (await get(realApp, `/${ward.slug}/admin/`, cookie)).text();
  expect(await top()).toContain("今は、よくある自治会の一年を仮に置いています。");
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added) VALUES (?, ?, ?, 12, 1)").bind(ward.wardId, crypto.randomUUID(), "年末の見回り").run();
  const after = await top();
  expect(after).toContain("届いた資料から、「年末の見回り」が、この自治会の予定だと分かりました。ほかの予定は、よくある自治会の例を仮に置いています。");
  expect(after).not.toContain("今は、よくある自治会の一年を仮に置いています。");
});
