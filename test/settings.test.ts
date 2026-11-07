import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAccount, seedAdmin, seedDeviceCookie, seedSeat, seedWard } from "../src/core/testing";
import { DEFAULT_TEMPLATES, SETTING_KEYS, linesToList, renderTemplate } from "../src/settings/keys";
import { getPublicContact, getSetting, getSquads, getTemplates, setSetting } from "../src/settings/store";
import { cookieFrom, get, postForm, realApp } from "./helpers";

const secretOf = (html: string) => /class="secret">([a-z0-9-]+)</.exec(html)?.[1];
const people = (slug: string, rest = "") => `/${slug}/admin/settings/people${rest}`;
const invitationOf = (html: string) => /class="secret invite-link">([^<]+)</.exec(html)?.[1];

describe("自治会の設定: 役員の席とアカウント", () => {
  it("自治会の設定の入口とそれぞれの画面が開く", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    for (const path of ["/admin/", "/admin/settings", "/admin/settings/people", "/admin/settings/info", "/admin/settings/templates"]) {
      const res = await get(realApp, `/${ward.slug}${path}`, cookie);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await (await get(realApp, people(ward.slug), cookie)).text()).toContain("試験の役員（架空）");
  });

  it("席を足し、同じ名前は足せず、外せる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const added = await postForm(realApp, people(ward.slug, "/seats"), { title: "会計" }, cookie);
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(people(ward.slug, "?done=seat-added"));
    const page = await (await get(realApp, added.headers.get("location")!, cookie)).text();
    expect(page).toContain("役職を足しました");
    expect(page).toContain("会計");

    const dup = await postForm(realApp, people(ward.slug, "/seats"), { title: "会計" }, cookie);
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain("同じ名前の役職がもうあります");

    const seat = await env.DB.prepare("SELECT seat_id FROM seats WHERE ward_id = ? AND title = ?")
      .bind(ward.wardId, "会計")
      .first<{ seat_id: string }>();
    const removed = await postForm(realApp, people(ward.slug, `/seats/${seat!.seat_id}/remove`), {}, cookie);
    expect(removed.status).toBe(303);
    expect(await (await get(realApp, people(ward.slug), cookie)).text()).not.toContain("会計");
  });

  it("役員を足すとリンクが出て、本人がパスワードを作れる。席も付けられる", async () => {
    const { ward, cookie, account } = await seedAdmin(env.DB);
    const seatId = await seedSeat(env.DB, ward.wardId, "書記");
    const res = await postForm(realApp, people(ward.slug, "/accounts"), { name: "新しい 書記", seatId }, cookie);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const invitation = invitationOf(await res.text());
    expect(invitation).toBeTruthy();
    const path = new URL(invitation!).pathname;
    const password = secretOf(await (await postForm(realApp, `${path}/password`, {})).text());
    expect(password).toMatch(/^[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);

    // 一覧にはリンクの本体もパスワードも出ない
    const list = await (await get(realApp, people(ward.slug), cookie)).text();
    expect(list).not.toContain(password!);
    expect(list).not.toContain(invitation!);
    expect(list).toContain("新しい 書記");

    const login = await postForm(realApp, `/${ward.slug}/admin/login`, { name: "新しい書記", password: password! });
    expect(login.status).toBe(303);
    const row = await env.DB.prepare("SELECT seat_id, created_by_account_id FROM accounts WHERE ward_id = ? AND name = ?")
      .bind(ward.wardId, "新しい 書記")
      .first<{ seat_id: string; created_by_account_id: string }>();
    expect(row?.seat_id).toBe(seatId);
    expect(row?.created_by_account_id).toBe(account.accountId);

    const dup = await postForm(realApp, people(ward.slug, "/accounts"), { name: "新しい書記" }, cookie);
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain("同じ名前の役員がもうあります");
  });

  // U16: リンクの出し直しはパスワードだけを失効させ、端末の締め出しとは分ける。
  it("リンクを出し直すと、古いパスワードは使えず、覚えた端末は残る", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const other = await seedAccount(env.DB, ward.wardId, "別の役員");
    const otherCookie = await seedDeviceCookie(env.DB, ward.wardId, other.accountId);
    const res = await postForm(realApp, people(ward.slug, `/accounts/${other.accountId}/reset`), {}, cookie);
    expect(res.status).toBe(200);
    const invitation = invitationOf(await res.text());
    expect(invitation).toBeTruthy();
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: other.name, password: other.password })).status).toBe(401);
    expect((await get(realApp, `/${ward.slug}/admin/`, otherCookie)).status).toBe(200);
    const password = secretOf(await (await postForm(realApp, `${new URL(invitation!).pathname}/password`, {})).text());
    expect(password).toMatch(/^[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);
    expect(password).not.toBe(other.password);
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: other.name, password: other.password })).status).toBe(401);
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: other.name, password: password! })).status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, otherCookie)).status).toBe(200);
  });

  it("自分のリンクも一覧から出せて、今の端末とほかの端末を残す", async () => {
    const { ward, cookie, account } = await seedAdmin(env.DB);
    const otherDevice = await seedDeviceCookie(env.DB, ward.wardId, account.accountId);
    const res = await postForm(realApp, people(ward.slug, `/accounts/${account.accountId}/reset`), {}, cookie);
    expect(res.status).toBe(200);
    const invitation = invitationOf(await res.text());
    expect(invitation).toBeTruthy();
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: account.name, password: account.password })).status).toBe(401);
    expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(200);
    expect((await get(realApp, `/${ward.slug}/admin/`, otherDevice)).status).toBe(200);
    const password = secretOf(await (await postForm(realApp, `${new URL(invitation!).pathname}/password`, {})).text());
    expect(password).toMatch(/^[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);
    expect(password).not.toBe(account.password);
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: account.name, password: account.password })).status).toBe(401);
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: account.name, password: password! })).status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(200);
    expect((await get(realApp, `/${ward.slug}/admin/`, otherDevice)).status).toBe(200);
  });

  it("外す: 最後の一人は外せず、二人目がいれば外せて、その端末は入れなくなる", async () => {
    const { ward, cookie, account } = await seedAdmin(env.DB);
    const refused = await postForm(realApp, people(ward.slug, `/accounts/${account.accountId}/remove`), {}, cookie);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("最後の一人は外せません");

    const other = await seedAccount(env.DB, ward.wardId, "外される人");
    const otherCookie = await seedDeviceCookie(env.DB, ward.wardId, other.accountId);
    const removed = await postForm(realApp, people(ward.slug, `/accounts/${other.accountId}/remove`), {}, cookie);
    expect(removed.status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, otherCookie)).status).toBe(303);
    expect((await postForm(realApp, `/${ward.slug}/admin/login`, { name: other.name, password: other.password })).status).toBe(401);
  });

  it("席の付け替えができ、席が無くても全部使える", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const seatId = await seedSeat(env.DB, ward.wardId, "副会長");
    const other = await seedAccount(env.DB, ward.wardId, "交代する人");
    const res = await postForm(realApp, people(ward.slug, `/accounts/${other.accountId}/seat`), { seatId }, cookie);
    expect(res.status).toBe(303);
    const row = await env.DB.prepare("SELECT seat_id FROM accounts WHERE account_id = ?").bind(other.accountId).first<{ seat_id: string }>();
    expect(row?.seat_id).toBe(seatId);
    // 席ありの人も席なしの人も、同じ画面を操作できる
    const holderCookie = await seedDeviceCookie(env.DB, ward.wardId, other.accountId);
    expect((await get(realApp, people(ward.slug), holderCookie)).status).toBe(200);
    expect((await postForm(realApp, people(ward.slug, "/seats"), { title: "会計" }, holderCookie)).status).toBe(303);
  });

  it("端末の締め出し: 一台だけ、またはこの端末以外の全部", async () => {
    const { ward, cookie, account } = await seedAdmin(env.DB);
    const lost = await seedDeviceCookie(env.DB, ward.wardId, account.accountId);
    const another = await seedDeviceCookie(env.DB, ward.wardId, account.accountId);
    const lostToken = lost.split("=")[1]!;
    const { sha256Hex } = await import("../src/core/password");
    const lostDevice = await env.DB.prepare("SELECT device_id FROM devices WHERE token_hash = ?")
      .bind(await sha256Hex(lostToken))
      .first<{ device_id: string }>();

    const one = await postForm(realApp, people(ward.slug, `/accounts/${account.accountId}/devices/${lostDevice!.device_id}/lockout`), {}, cookie);
    expect(one.status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, lost)).status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, another)).status).toBe(200);

    const all = await postForm(realApp, people(ward.slug, `/accounts/${account.accountId}/lockout`), {}, cookie);
    expect(all.status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, another)).status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(200); // いまの端末は残る
  });

  it("他の区の席、アカウント、端末は、自分の自治会のURLからは触れない", async () => {
    const a = await seedAdmin(env.DB);
    const b = await seedAdmin(env.DB);
    await seedAccount(env.DB, b.ward.wardId, "Bの二人目");
    const bSeat = await seedSeat(env.DB, b.ward.wardId, "Bの会長");
    const bDevice = await seedDeviceCookie(env.DB, b.ward.wardId, b.account.accountId);
    const bDeviceId = (
      await env.DB.prepare("SELECT device_id FROM devices WHERE ward_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(b.ward.wardId)
        .first<{ device_id: string }>()
    )?.device_id;

    const attempts = [
      postForm(realApp, people(a.ward.slug, `/accounts/${b.account.accountId}/remove`), {}, a.cookie),
      postForm(realApp, people(a.ward.slug, `/accounts/${b.account.accountId}/reset`), {}, a.cookie),
      postForm(realApp, people(a.ward.slug, `/accounts/${b.account.accountId}/lockout`), {}, a.cookie),
      postForm(realApp, people(a.ward.slug, `/accounts/${b.account.accountId}/devices/${bDeviceId}/lockout`), {}, a.cookie),
      postForm(realApp, people(a.ward.slug, `/accounts/${a.account.accountId}/seat`), { seatId: bSeat }, a.cookie),
      postForm(realApp, people(a.ward.slug, `/seats/${bSeat}/remove`), {}, a.cookie),
    ];
    await Promise.all(attempts);

    expect((await get(realApp, `/${b.ward.slug}/admin/`, b.cookie)).status).toBe(200);
    expect((await get(realApp, `/${b.ward.slug}/admin/`, bDevice)).status).toBe(200);
    const seat = await env.DB.prepare("SELECT removed_at FROM seats WHERE seat_id = ?").bind(bSeat).first<{ removed_at: string | null }>();
    expect(seat?.removed_at).toBeNull();
    const mine = await env.DB.prepare("SELECT seat_id FROM accounts WHERE account_id = ?").bind(a.account.accountId).first<{ seat_id: string | null }>();
    expect(mine?.seat_id).toBeNull();
    const aList = await (await get(realApp, people(a.ward.slug), a.cookie)).text();
    expect(aList).not.toContain("Bの二人目");
    expect(aList).not.toContain("Bの会長");
  });

  it("別のoriginからのPOSTは受けない", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const res = await postForm(realApp, people(ward.slug, "/seats"), { title: "会長" }, cookie, env, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("役員画面に入っていなければ、席もアカウントも触れない", async () => {
    const { ward } = await seedAdmin(env.DB);
    const res = await postForm(realApp, people(ward.slug, "/seats"), { title: "会長" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/admin/login");
    expect(cookieFrom(res, "device")).toBeNull();
  });
});

describe("自治会の設定: 自治会の情報と決まった知らせの文", () => {
  it("公開用の連絡先と班の名前を保存し、空にすると消える", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const res = await postForm(realApp, `/${ward.slug}/admin/settings/info`, { contact: "自治会の窓口\n電話000-0000-0000（架空）", squads: " 1班\n2班\n\n2班\n 3班 " }, cookie);
    expect(res.status).toBe(303);
    expect(await getPublicContact(env.DB, ward.wardId)).toBe("自治会の窓口\n電話000-0000-0000（架空）");
    expect(await getSquads(env.DB, ward.wardId)).toEqual(["1班", "2班", "3班"]);
    const page = await (await get(realApp, `/${ward.slug}/admin/settings/info`, cookie)).text();
    expect(page).toContain("自治会の窓口");
    expect(page).toContain("3班");

    await postForm(realApp, `/${ward.slug}/admin/settings/info`, { contact: "", squads: "" }, cookie);
    expect(await getSetting(env.DB, ward.wardId, SETTING_KEYS.publicContact)).toBeNull();
    expect(await getSetting(env.DB, ward.wardId, SETTING_KEYS.squads)).toBeNull();
  });

  it("長すぎる入力は保存せず、入力を残して知らせる。HTMLはescapeされる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const res = await postForm(realApp, `/${ward.slug}/admin/settings/info`, { contact: "<script>alert(1)</script>", squads: `${"あ".repeat(21)}` }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("班の名前は");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(await getSquads(env.DB, ward.wardId)).toEqual([]);
  });

  it("決まった知らせの文: 標準が出て、足す、直す、消す、標準に戻すができる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const url = `/${ward.slug}/admin/settings/templates`;
    expect(await (await get(realApp, url, cookie)).text()).toContain(DEFAULT_TEMPLATES[0]!.name);

    expect((await postForm(realApp, url, { name: "中止の知らせ", body: "{行事名}は中止します。" }, cookie)).status).toBe(303);
    let list = await getTemplates(env.DB, ward.wardId);
    expect(list.map((t) => t.name)).toEqual(["雨の変更の連絡", "中止の知らせ"]);

    const added = list[1]!;
    expect((await postForm(realApp, `${url}/${added.id}`, { name: "中止のお知らせ", body: "{行事名}は中止です。" }, cookie)).status).toBe(303);
    list = await getTemplates(env.DB, ward.wardId);
    expect(list[1]).toMatchObject({ name: "中止のお知らせ", body: "{行事名}は中止です。" });

    expect((await postForm(realApp, `${url}/${list[0]!.id}/remove`, {}, cookie)).status).toBe(303);
    expect((await getTemplates(env.DB, ward.wardId)).map((t) => t.name)).toEqual(["中止のお知らせ"]);
    expect((await postForm(realApp, `${url}/no-such/remove`, {}, cookie)).status).toBe(404);
    expect((await postForm(realApp, url, { name: "", body: "x" }, cookie)).status).toBe(400);

    expect((await postForm(realApp, `${url}/reset`, {}, cookie)).status).toBe(303);
    expect((await getTemplates(env.DB, ward.wardId)).map((t) => t.name)).toEqual(["雨の変更の連絡"]);
  });

  it("設定は自治会ごとに分かれる", async () => {
    const a = await seedAdmin(env.DB);
    const b = await seedAdmin(env.DB);
    await postForm(realApp, `/${a.ward.slug}/admin/settings/info`, { contact: "Aの窓口", squads: "A1班" }, a.cookie);
    expect(await getPublicContact(env.DB, b.ward.wardId)).toBe("");
    expect(await getSquads(env.DB, b.ward.wardId)).toEqual([]);
    expect(await getPublicContact(env.DB, a.ward.wardId)).toBe("Aの窓口");
  });
});

describe("設定の保存と決まった知らせの文の部品", () => {
  it("上書きでき、不正なキーと大きすぎる値は拒む", async () => {
    const ward = await seedWard(env.DB);
    await setSetting(env.DB, ward.wardId, "line.enabled", "1");
    await setSetting(env.DB, ward.wardId, "line.enabled", "0");
    expect(await getSetting(env.DB, ward.wardId, "line.enabled")).toBe("0");
    await expect(setSetting(env.DB, ward.wardId, "Bad Key", "x")).rejects.toThrow();
    await expect(setSetting(env.DB, ward.wardId, "k", "x".repeat(20_001))).rejects.toThrow();
    const other = await seedWard(env.DB);
    expect(await getSetting(env.DB, other.wardId, "line.enabled")).toBeNull();
  });

  it("決まった知らせの文の {言葉}を置き換え、値のない言葉は残す", () => {
    expect(renderTemplate("{行事名}は{会場}で。{日時}", { 行事名: "収穫祭", 会場: "公民館" })).toBe("収穫祭は公民館で。{日時}");
    expect(renderTemplate("{ 会場 }", { 会場: "ホール" })).toBe("ホール");
    expect(renderTemplate("波括弧なし", {})).toBe("波括弧なし");
  });

  it("テキスト欄の一行に一つを整える", () => {
    expect(linesToList(" 1班 \r\n\r\n2班\n1班\n  3班 ")).toEqual(["1班", "2班", "3班"]);
  });
});
