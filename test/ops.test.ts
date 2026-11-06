import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { wardUrl } from "../src/core/ward";
import { OPS_COOKIE, createOpsSession, verifyOpsSession } from "../src/ops/session";
import { qrSvg } from "../src/print";
import { uniqueSlug } from "../src/core/testing";
import { OPS_ID, OPS_PASSWORD, cookieFrom, get, opsEnv, postForm, realApp, withEnv } from "./helpers";

async function opsLogin(): Promise<string> {
  const res = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv);
  const cookie = cookieFrom(res, OPS_COOKIE);
  expect(cookie).not.toBeNull();
  return cookie!;
}

const JSON_HEADERS = { accept: "application/json" };

describe("運用の画面の入る", () => {
  it("OPS_IDとOPS_PASSWORDがなければ開かない", async () => {
    const res = await get(realApp, "/ops/login");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("設定されていません");
    expect((await get(realApp, "/ops/")).status).toBe(503);
  });

  it("IDとパスワードが合えば入れ、札は /opsに限り、JavaScriptから読めない", async () => {
    const res = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ops/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/ops");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(OPS_PASSWORD);
  });

  it("違えば401で、札を渡さない（IDが違う時もパスワードが違う時も同じ答え）", async () => {
    const wrongPassword = await postForm(realApp, "/ops/login", { id: OPS_ID, password: "x" }, undefined, opsEnv);
    const wrongId = await postForm(realApp, "/ops/login", { id: "x", password: OPS_PASSWORD }, undefined, opsEnv);
    for (const res of [wrongPassword, wrongId]) {
      expect(res.status).toBe(401);
      expect(cookieFrom(res, OPS_COOKIE)).toBeNull();
      expect(await res.text()).toContain("IDかパスワードが違います");
    }
  });

  it("役員画面に入っていなければ入る画面へ送る。機械の呼び出しには401", async () => {
    const page = await get(realApp, "/ops/", undefined, opsEnv);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/ops/login");
    const json = await get(realApp, "/ops/wards/x", undefined, opsEnv, JSON_HEADERS);
    expect(json.status).toBe(401);
  });

  it("札は改ざんできず、期限が過ぎれば無効で、パスワードを変えると無効になる", async () => {
    const now = 1_800_000_000_000;
    const token = await createOpsSession(opsEnv, now);
    expect(await verifyOpsSession(opsEnv, token, now + 1000)).toBe(true);
    expect(await verifyOpsSession(opsEnv, token, now + 13 * 60 * 60 * 1000)).toBe(false);
    const [expires, mac] = token.split(".");
    expect(await verifyOpsSession(opsEnv, `${Number(expires) + 100000}.${mac}`, now)).toBe(false);
    expect(await verifyOpsSession(opsEnv, `${expires}.${"0".repeat(64)}`, now)).toBe(false);
    expect(await verifyOpsSession(opsEnv, "garbage", now)).toBe(false);
    expect(await verifyOpsSession(opsEnv, undefined, now)).toBe(false);
    const rotated = withEnv({ OPS_ID, OPS_PASSWORD: `${OPS_PASSWORD}-new` });
    expect(await verifyOpsSession(rotated, token, now)).toBe(false);
  });

  it("役員画面の札では運用の画面に入れない", async () => {
    const res = await get(realApp, "/ops/", "device=abc", opsEnv);
    expect(res.status).toBe(303);
  });
});

describe("区の開設", () => {
  it("区と最初の役員を作り、そのパスワードで役員画面に入れる", async () => {
    const cookie = await opsLogin();
    const slug = uniqueSlug("open");
    const res = await postForm(
      realApp,
      "/ops/wards",
      { name: "試験の区（架空）", slug, firstAccountName: "最初の役員" },
      cookie,
      opsEnv,
      JSON_HEADERS,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      slug: string;
      url: string;
      adminUrl: string;
      qrSvgUrl: string;
      account: { name: string; password: string };
    };
    expect(body.slug).toBe(slug);
    expect(body.url).toBe(`${env.PUBLIC_BASE_URL}/${slug}/`);
    expect(body.adminUrl).toBe(`${env.PUBLIC_BASE_URL}/${slug}/admin/`);
    expect(body.account.password).toMatch(/^[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);

    const login = await postForm(realApp, `/${slug}/admin/login`, {
      name: body.account.name,
      password: body.account.password,
    });
    expect(login.status).toBe(303);
    const home = await get(realApp, `/${slug}/admin/`, cookieFrom(login, "device")!);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("試験の区（架空）");

    // パスワードそのものは D1 に残らない
    const stored = await env.DB.prepare("SELECT password_hash, password_salt FROM accounts WHERE name = ?")
      .bind("最初の役員")
      .all<{ password_hash: string; password_salt: string }>();
    expect(JSON.stringify(stored.results)).not.toContain(body.account.password);
  });

  it("画面からも開け、結果の画面にパスワードが一度だけ出る", async () => {
    const cookie = await opsLogin();
    const slug = uniqueSlug("form");
    const res = await postForm(realApp, "/ops/wards", { name: "画面から開く区", slug, firstAccountName: "役員A" }, cookie, opsEnv);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("区を開きました");
    expect(html).toMatch(/class="secret">[a-z0-9]{6}(-[a-z0-9]{6}){3}</);
    expect(html).toContain(`/${slug}/`);
    // 一覧には出るが、パスワードは出ない
    const list = await (await get(realApp, "/ops/", cookie, opsEnv)).text();
    expect(list).toContain("画面から開く区");
    expect(list).not.toMatch(/class="secret"/);
  });

  it("使えないURL、重複、名前の抜けは開かない", async () => {
    const cookie = await opsLogin();
    const open = (form: Record<string, string>) =>
      postForm(realApp, "/ops/wards", form, cookie, opsEnv, JSON_HEADERS);
    const base = { name: "区", firstAccountName: "役員" };

    for (const slug of ["ops", "contact", "Bad_Slug", "a", "-x", "区"]) {
      const res = await open({ ...base, slug });
      expect(res.status, slug).toBe(400);
    }
    const slug = uniqueSlug("dup");
    expect((await open({ ...base, slug })).status).toBe(201);
    const dup = await open({ ...base, slug });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { message: string }).message).toContain("もう使われています");
    expect((await open({ name: "", slug: uniqueSlug("n"), firstAccountName: "役員" })).status).toBe(400);

    // 最初の役員の名前が使えない時は、区だけが残らない
    const orphan = uniqueSlug("orphan");
    expect((await open({ name: "区", slug: orphan, firstAccountName: "   " })).status).toBe(400);
    expect(await env.DB.prepare("SELECT 1 FROM wards WHERE slug = ?").bind(orphan).first()).toBeNull();
  });

  it("複数の区が並んで動き、互いのアカウントでは入れない", async () => {
    const cookie = await opsLogin();
    const open = async (name: string) => {
      const slug = uniqueSlug("multi");
      const res = await postForm(realApp, "/ops/wards", { name, slug, firstAccountName: "同じ名前の役員" }, cookie, opsEnv, JSON_HEADERS);
      return (await res.json()) as { slug: string; account: { name: string; password: string } };
    };
    const a = await open("区A（架空）");
    const b = await open("区B（架空）");
    expect(a.account.password).not.toBe(b.account.password);

    const aLogin = await postForm(realApp, `/${a.slug}/admin/login`, a.account);
    const bLogin = await postForm(realApp, `/${b.slug}/admin/login`, b.account);
    expect(aLogin.status).toBe(303);
    expect(bLogin.status).toBe(303);
    // A のパスワードで B には入れない（名前が同じでも）
    expect((await postForm(realApp, `/${b.slug}/admin/login`, a.account)).status).toBe(401);
    // A の端末の記憶で B の役員画面は開かない
    expect((await get(realApp, `/${b.slug}/admin/`, cookieFrom(aLogin, "device")!)).status).toBe(303);
  });
});

describe("固定URLとQRと案内", () => {
  it("区の画面にURLとQRが出る。QRの画像は区のページのURL", async () => {
    const cookie = await opsLogin();
    const slug = uniqueSlug("qr");
    await postForm(realApp, "/ops/wards", { name: "QRの区", slug, firstAccountName: "役員" }, cookie, opsEnv);
    const url = wardUrl(env, "http://localhost/", slug);

    const detail = await (await get(realApp, `/ops/wards/${slug}`, cookie, opsEnv)).text();
    expect(detail).toContain(url);
    expect(detail).toContain("<svg");

    const svg = await get(realApp, `/ops/wards/${slug}/qr.svg`, cookie, opsEnv);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toBe(qrSvg(url));

    const sheet = await (await get(realApp, `/ops/wards/${slug}/sheet`, cookie, opsEnv)).text();
    expect(sheet).toContain("size: A4 portrait");
    expect(sheet).toContain(url);
  });

  it("ない区は404", async () => {
    const cookie = await opsLogin();
    expect((await get(realApp, "/ops/wards/none-such", cookie, opsEnv)).status).toBe(404);
    expect((await get(realApp, "/ops/wards/none-such/qr.svg", cookie, opsEnv)).status).toBe(404);
    expect((await get(realApp, "/ops/wards/none-such/sheet", cookie, opsEnv)).status).toBe(404);
  });
});

describe("役員が入れなくなったときの復旧（提供側）", () => {
  it("区の画面からは足さず、作り直さず、問い合わせの受付へ案内する", async () => {
    const cookie = await opsLogin();
    const slug = uniqueSlug("recover");
    await postForm(realApp, "/ops/wards", { name: "復旧の区（架空）", slug, firstAccountName: "役員" }, cookie, opsEnv, JSON_HEADERS);
    const ward = await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ?)").bind(slug).first<{ ward_id: string }>();
    const account = await env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND name = ?").bind(ward!.ward_id, "役員").first<{ account_id: string }>();
    expect((await postForm(realApp, `/ops/wards/${slug}/accounts`, { name: "新しい役員（架空）" }, cookie, opsEnv)).status).toBe(404);
    expect((await postForm(realApp, `/ops/wards/${slug}/accounts/${account!.account_id}/reset`, {}, cookie, opsEnv)).status).toBe(404);
    const html = await (await get(realApp, `/ops/wards/${slug}`, cookie, opsEnv)).text();
    expect(html).toContain('href="/ops/contacts"');
    expect(html).not.toContain('/accounts/');
    expect(html).not.toContain('name="name"');
  });
});
