import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { DEVICE_COOKIE } from "../src/core/auth";
import { sha256Hex } from "../src/core/password";
import { connectVerifiedSignIn, createInvitation } from "../src/core/sign-in";
import type { SignInConnection, SignInIntent } from "../src/core/sign-in-connections";
import { seedAdmin } from "../src/core/testing";
import { cookieFrom, get, postForm, realApp } from "./helpers";

const invitePath = (html: string) => {
  const link = /class="secret invite-link">([^<]+)</.exec(html)?.[1];
  expect(link).toBeTruthy();
  return new URL(link!).pathname;
};

it("役員にリンクを渡し、本人が入り方を作り、足す・外す・戻す・入り直す", async () => {
  const owner = await seedAdmin(env.DB);
  const anotherWard = await seedAdmin(env.DB);
  const base = `/${owner.ward.slug}/admin`;
  const people = `${base}/settings/people`;
  const name = `招待の役員（架空）${crypto.randomUUID().slice(0, 6)}`;

  // 本物の経路とD1を通し、値は毎回作る。LINEへは接続せず、本人確認の接続だけを偽物にする。
  const pending = new Map<string, { wardId: string; intent: SignInIntent }>();
  const lineSubject = `fictional-line-${crypto.randomUUID()}`;
  const line: SignInConnection = {
    async start(c, intent) {
      const state = crypto.randomUUID();
      pending.set(state, { wardId: c.var.ward.wardId, intent });
      return c.redirect(`${base}/sign-in-connect/line/callback?state=${state}`, 303);
    },
    async finish(c) {
      const state = c.req.query("state") ?? "";
      const saved = pending.get(state);
      pending.delete(state);
      if (!saved || saved.wardId !== c.var.ward.wardId) return null;
      return { identity: { kind: "line", subject: lineSubject }, intent: saved.intent };
    },
  };
  const bindings = Object.create(env, { SIGN_IN_CONNECTIONS: { value: { line } } }) as typeof env;
  const completeLine = async (form: Record<string, string>, cookie?: string) => {
    const start = await postForm(realApp, `${base}/sign-in-connect/line/start`, form, cookie, bindings);
    expect(start.status).toBe(303);
    const callback = start.headers.get("location");
    expect(callback).toBeTruthy();
    return get(realApp, callback!, cookie, bindings);
  };

  const legacy = await postForm(realApp, `${base}/login`, { loginId: owner.account.loginId, password: owner.account.password });
  expect(legacy.status).toBe(303);
  const loginHtml = await (await get(realApp, `${base}/login`)).text();
  expect(loginHtml).not.toContain("LINEで入る");
  expect(loginHtml).not.toContain("メールで入る");
  expect(await (await get(realApp, `${base}/login/help`)).text()).toContain("ほかの役員に頼んでください");

  const created = await postForm(realApp, `${people}/accounts`, { name }, owner.cookie);
  expect(created.status).toBe(201);
  const first = invitePath(await created.text());
  const account = await env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND name = ?")
    .bind(owner.ward.wardId, name).first<{ account_id: string }>();
  expect(account).not.toBeNull();
  const target = account!.account_id;
  const stored = await env.DB.prepare("SELECT token_hash, used_at, expires_at, created_at FROM sign_in_links WHERE ward_id = ? AND account_id = ?")
    .bind(owner.ward.wardId, target).first<{ token_hash: string; used_at: string | null; expires_at: string; created_at: string }>();
  expect(stored?.token_hash).toBe(await sha256Hex(first.split("/").pop()!));
  expect(Date.parse(stored!.expires_at) - Date.parse(stored!.created_at)).toBeCloseTo(7 * 24 * 3600_000, -2);
  expect(stored?.used_at).toBeNull();
  expect((await get(realApp, first)).status).toBe(200);
  expect((await get(realApp, first)).status).toBe(200);
  const copiedAcrossWards = first.replace(`/${owner.ward.slug}/`, `/${anotherWard.ward.slug}/`);
  expect((await get(realApp, copiedAcrossWards)).status).toBe(400);

  const remade = await postForm(realApp, `${people}/accounts/${target}/reset`, {}, owner.cookie);
  const remadeHtml = await remade.text();
  expect(remadeHtml).toContain("リンクを作り直しました");
  const current = invitePath(remadeHtml);
  expect(current).not.toBe(first);
  expect((await get(realApp, first)).status).toBe(400);
  const chosen = await postForm(realApp, `${current}/password`, {});
  expect(chosen.status).toBe(200);
  const chosenHtml = await chosen.text();
  const password = /class="secret">([^<]+)</.exec(chosenHtml)?.[1];
  const loginId = /ID: <strong>([^<]+)</.exec(chosenHtml)?.[1];
  expect(password).toMatch(/^[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);
  expect(loginId).toBeTruthy();
  const cookie = cookieFrom(chosen, DEVICE_COOKIE);
  expect(cookie).toBeTruthy();
  const used = await postForm(realApp, `${current}/password`, {});
  expect(used.status).toBe(400);
  expect(cookieFrom(used, DEVICE_COOKIE)).toBeNull();
  const usedHtml = await (await get(realApp, current)).text();
  expect(usedHtml).toContain("このリンクは使えません");
  expect((await get(realApp, `${base}/sign-in/done`, cookie!)).status).toBe(200);
  const last = await postForm(realApp, `${base}/sign-in/password/remove`, {}, cookie!);
  expect(last.status).toBe(400);
  expect(await last.text()).toContain("最後の一つは外せません");

  const linked = await completeLine({ add: "1" }, cookie!);
  expect(linked.headers.get("location")).toContain("/sign-in/saved?kind=line");
  const duplicate = await completeLine({ add: "1" }, owner.cookie);
  expect(duplicate.status).toBe(400);
  expect(await duplicate.text()).toContain("別の役員につないであります");
  const email = `fictional-${crypto.randomUUID()}@example.invalid`;
  expect((await connectVerifiedSignIn(env.DB, owner.ward.wardId, { accountId: target }, { kind: "email", email })).ok).toBe(true);
  expect(await connectVerifiedSignIn(env.DB, owner.ward.wardId, { accountId: owner.account.accountId }, { kind: "email", email: email.toUpperCase() }))
    .toMatchObject({ ok: false, message: "別の役員につないであります。" });
  expect((await get(realApp, `${base}/sign-in/password/remove`, cookie!)).status).toBe(404);
  const removed = await postForm(realApp, `${base}/sign-in/password/remove`, {}, cookie!);
  expect(removed.status).toBe(303);
  expect(await (await get(realApp, removed.headers.get("location")!, cookie!)).text()).toContain("IDとパスワードをつなぎ直す");
  expect((await postForm(realApp, `${base}/login`, { loginId: loginId!, password: password! })).status).toBe(401);
  const restored = await postForm(realApp, `${base}/sign-in/password`, {}, cookie!);
  expect(restored.status).toBe(200);
  expect(await restored.text()).toContain("/sign-in/saved?kind=password");
  expect((await completeLine({})).status).toBe(303);

  const list = await (await get(realApp, people, owner.cookie)).text();
  expect(list).toContain("入り方を作り直した記録");
  expect(list).not.toContain(`/accounts/${owner.account.accountId}/reset`);
  const groupKey = `LINE_${owner.ward.wardId.toUpperCase().replaceAll("-", "_")}_OFFICER_GROUP_ID`;
  const groupId = `fictional-${crypto.randomUUID()}`;
  const noticeBindings = Object.create(bindings, {
    [groupKey]: { value: groupId }, LINE_CHANNEL_ACCESS_TOKEN: { value: crypto.randomUUID() },
  }) as typeof env;
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(owner.ward.wardId, crypto.randomUUID()).run();
  const notices: string[] = [];
  const fakeLine = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/members/count")) return Response.json({ count: 2 });
    if (url.endsWith("/message/push")) {
      const sent = JSON.parse(String(init?.body)) as { to: string; messages: { text: string }[] };
      expect(sent.to).toBe(groupId);
      notices.push(sent.messages[0]!.text);
      return Response.json({ sentMessages: [{ id: crypto.randomUUID() }] });
    }
    throw new Error("この試験で許可しない外部の呼び出しです");
  });
  let reset: Response;
  try { reset = await postForm(realApp, `${people}/accounts/${target}/reset`, {}, owner.cookie, noticeBindings); }
  finally { fakeLine.mockRestore(); }
  const resetHtml = await reset.text();
  expect(resetHtml).toContain("入り方を作り直しました");
  expect(resetHtml).toContain("役員グループへ知らせました");
  expect(notices).toHaveLength(1);
  expect(notices[0]).not.toContain("/invite/");
  expect((await get(realApp, `${base}/sign-in`, cookie!)).status).toBe(303);
  const again = invitePath(resetHtml);
  const lineStart = await postForm(realApp, `${base}/sign-in-connect/line/start`, { invitation: again.split("/").pop()! }, undefined, bindings);
  expect((await get(realApp, again)).status).toBe(200); // 本人確認の開始だけでは消さない。
  const lineDone = await get(realApp, lineStart.headers.get("location")!, undefined, bindings);
  expect(lineDone.headers.get("location")).toBe(`${base}/sign-in/done`);
  expect(cookieFrom(lineDone, DEVICE_COOKIE)).toBeTruthy();
  expect((await get(realApp, again)).status).toBe(400);

  const provider = await createInvitation(env.DB, owner.ward.wardId, target, { provider: true });
  expect(provider.ok).toBe(true);
  if (!provider.ok) throw new Error(provider.message);
  const provided = await env.DB.prepare("SELECT created_at FROM sign_in_links WHERE ward_id = ? AND token_hash = ?")
    .bind(owner.ward.wardId, await sha256Hex(provider.token)).first<{ created_at: string }>();
  expect(Date.parse(provider.expiresAt) - Date.parse(provided!.created_at)).toBe(24 * 3600_000);
  await env.DB.prepare("UPDATE sign_in_links SET expires_at = ? WHERE ward_id = ? AND token_hash = ?")
    .bind(new Date(Date.now() - 1000).toISOString(), owner.ward.wardId, await sha256Hex(provider.token)).run();
  expect(await (await get(realApp, `${base}/invite/${provider.token}`)).text()).toBe(usedHtml);
});
