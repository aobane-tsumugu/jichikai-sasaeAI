import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEVICE_COOKIE } from "../src/core/auth";
import { seedAccount, seedAdmin, seedDeviceCookie, seedSeat, seedWard, uniqueSlug } from "../src/core/testing";
import { cookieFrom, get, postForm, realApp } from "./helpers";

describe("役員画面の入口", () => {
  it("役員画面に入っていなければ入る画面へ送る", async () => {
    const { ward } = await seedAdmin(env.DB);
    const res = await get(realApp, `/${ward.slug}/admin/`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/${ward.slug}/admin/login?next=${encodeURIComponent(`/${ward.slug}/admin/`)}`,
    );
  });

  it("入る画面は誰でも開ける", async () => {
    const { ward } = await seedAdmin(env.DB);
    const res = await get(realApp, `/${ward.slug}/admin/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("役員画面に入る");
    expect(html).toContain(ward.name);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("名前とパスワードで入り、端末の記憶で次から入れる", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    const login = await postForm(realApp, `/${ward.slug}/admin/login`, {
      name: account.name,
      password: account.password,
      next: `/${ward.slug}/admin/`,
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe(`/${ward.slug}/admin/`);
    const cookie = cookieFrom(login, DEVICE_COOKIE);
    expect(cookie).not.toBeNull();
    expect(login.headers.get("set-cookie")).toContain(`Path=/${ward.slug}/admin`);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");

    const home = await get(realApp, `/${ward.slug}/admin/`, cookie!);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("手元に去年の案内や資料はありますか");
    expect(home.headers.get("cache-control")).toBe("no-store");

    // 札そのものは D1 に持たない
    const token = cookie!.slice(DEVICE_COOKIE.length + 1);
    const stored = await env.DB.prepare("SELECT token_hash FROM devices WHERE ward_id = ?")
      .bind(ward.wardId)
      .all<{ token_hash: string }>();
    expect(stored.results.length).toBe(2); // seedAdmin の分とこのログインの分
    for (const row of stored.results) expect(row.token_hash).not.toBe(token);
  });

  it("パスワードの大文字小文字、ハイフン、全角の違いは同じに扱う", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    const typed = account.password.replace(/-/g, "").toUpperCase();
    const res = await postForm(realApp, `/${ward.slug}/admin/login`, { name: ` ${account.name} `, password: typed });
    expect(res.status).toBe(303);
  });

  it("間違ったパスワードと、ない名前は同じ答えで、札を渡さない", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    const wrongPassword = await postForm(realApp, `/${ward.slug}/admin/login`, {
      name: account.name,
      password: "zzzzzz-zzzzzz-zzzzzz-zzzzzz",
    });
    const unknownName = await postForm(realApp, `/${ward.slug}/admin/login`, {
      name: "いない人",
      password: account.password,
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownName.status).toBe(401);
    expect(cookieFrom(wrongPassword, DEVICE_COOKIE)).toBeNull();
    expect(cookieFrom(unknownName, DEVICE_COOKIE)).toBeNull();
    const a = await wrongPassword.text();
    const b = await unknownName.text();
    expect(a).toContain("IDかパスワードが違います。もう一度入れてください。分からないときは、ほかの役員に作り直してもらえます");
    expect(b).toContain("IDかパスワードが違います。もう一度入れてください。分からないときは、ほかの役員に作り直してもらえます");
  });

  it("入るあとの戻り先は役員画面の中だけ", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    for (const next of ["https://evil.example/", "//evil.example/", "/other-ward/admin/", "/x/../admin"]) {
      const res = await postForm(realApp, `/${ward.slug}/admin/login`, {
        name: account.name,
        password: account.password,
        next,
      });
      expect(res.headers.get("location")).toBe(`/${ward.slug}/admin/`);
    }
  });

  it("このスマホやパソコンから出るはこの端末の記憶だけを消す", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const other = await seedDeviceCookie(env.DB, ward.wardId, account.accountId);
    const out = await postForm(realApp, `/${ward.slug}/admin/logout`, {}, cookie);
    expect(out.status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(303);
    expect((await get(realApp, `/${ward.slug}/admin/`, other)).status).toBe(200);
  });

  it("外したアカウントの端末は入れない", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    await env.DB.prepare("UPDATE accounts SET removed_at = ? WHERE ward_id = ? AND account_id = ?")
      .bind(new Date().toISOString(), ward.wardId, account.accountId)
      .run();
    expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(303);
  });

  it("使わないまま長く過ぎた端末の記憶は無効", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const old = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE ward_id = ?").bind(old, ward.wardId).run();
    expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(303);
  });

  it("他の区の入るや端末の記憶では入れない", async () => {
    const a = await seedAdmin(env.DB);
    const b = await seedAdmin(env.DB, uniqueSlug("other"), a.account.name);
    // A の端末の記憶で B の役員画面は開かない
    expect((await get(realApp, `/${b.ward.slug}/admin/`, a.cookie)).status).toBe(303);
    // A のパスワードで B にログインできない（同じ名前でも）
    const res = await postForm(realApp, `/${b.ward.slug}/admin/login`, {
      name: a.account.name,
      password: a.account.password,
    });
    expect(res.status).toBe(401);
    // それぞれの区には、それぞれのアカウントで入れる
    expect((await get(realApp, `/${a.ward.slug}/admin/`, a.cookie)).status).toBe(200);
    expect((await get(realApp, `/${b.ward.slug}/admin/`, b.cookie)).status).toBe(200);
  });

  it("役の名札は鍵ではない: 席が無くても、どの席でも同じに入れる", async () => {
    const ward = await seedWard(env.DB);
    const seatId = await seedSeat(env.DB, ward.wardId, "会計");
    const noSeat = await seedAccount(env.DB, ward.wardId, "席のない人");
    const accountant = await seedAccount(env.DB, ward.wardId, "会計の人", { seatId });
    for (const account of [noSeat, accountant]) {
      const cookie = await seedDeviceCookie(env.DB, ward.wardId, account.accountId);
      expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(200);
    }
  });

  it("フォームのPOSTは同じoriginからだけ受ける", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    const res = await realApp.request(
      `/${ward.slug}/admin/login`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
        body: new URLSearchParams({ name: account.name, password: account.password }).toString(),
      },
      env,
    );
    expect(res.status).toBe(403);
  });
});
