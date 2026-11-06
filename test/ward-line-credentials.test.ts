import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { uniqueSlug } from "../src/core/testing";
import { LINE_NOT_CONFIGURED } from "../src/line/api";
import type { LineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { openWard } from "../src/ops/wards";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { cookieFrom, get, postForm, realApp, withEnv } from "./helpers";

async function openTestWard() {
  const destination = `U-fictional-${crypto.randomUUID()}`;
  const result = await openWard(env.DB, {
    slug: uniqueSlug("line-ward"), name: "区ごとのLINEの確認（架空）", firstAccountName: "役員（架空）",
    lineDestination: destination,
  });
  if (!result.ok) throw new Error("架空の区を開けません");
  return { ...result, destination };
}

it("開設した二つの区はそれぞれの鍵で配り、まだ決めていませんの区は全体の鍵があっても送らない", async () => {
  const first = await openTestWard();
  const second = await openTestWard();
  const missing = await openTestWard();
  if (!first.line || !second.line) throw new Error("架空のLINEの参照先がありません");
  const secrets = {
    [first.line.channelSecretBinding]: "fictional-secret-first",
    [first.line.accessTokenBinding]: "fictional-token-first",
    [second.line.channelSecretBinding]: "fictional-secret-second",
    [second.line.accessTokenBinding]: "fictional-token-second",
    LINE_CHANNEL_ACCESS_TOKEN: "fictional-global-token",
    LINE_CHANNEL_SECRET: "fictional-global-secret",
  };
  const bindings = withEnv(secrets);
  const calls: Array<{ url: string; authorization: string | null }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.includes("/insight/followers")) return Response.json({ status: "ready", followers: 2 });
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/message/broadcast")) return new Response(null, { status: 200 });
    throw new Error("この試験で予定していない外部通信です");
  });
  try {
    for (const [opened, token] of [[first, "fictional-token-first"], [second, "fictional-token-second"], [missing, null]] as const) {
      const root = `/${opened.ward.slug}/admin`;
      const login = await postForm(realApp, `${root}/login`, { loginId: opened.account.loginId, password: opened.account.password }, undefined, bindings);
      const cookie = cookieFrom(login, "device");
      expect(cookie).not.toBeNull();
      const project = await createProject(env.DB, opened.ward.wardId, {
        kind: "event", title: "架空の行事", year: 2026, accountId: opened.account.accountId,
      });
      expect(await saveDocument(env.DB, opened.ward.wardId, project.projectId, opened.account.accountId, {
        kind: "announcement", title: "架空の案内", scope: "public", body: JSON.stringify({ text: "架空の行事を開きます。", items: [] }), basedOn: project.stateVersion,
      })).toBe(true);
      const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
        .bind(opened.ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
      if (!version) throw new Error("架空の案内を保存できません");
      const start = calls.length;
      const sent = await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
        documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "send", distribution: "",
      }, cookie!, bindings);
      expect(sent.status).toBe(303);
      const record = await env.DB.prepare("SELECT line_status, line_error FROM publication_records WHERE ward_id = ? AND project_id = ?")
        .bind(opened.ward.wardId, project.projectId).first<{ line_status: string; line_error: string | null }>();
      expect(record?.line_status).toBe(token ? "sent" : "not_configured");
      const html = await (await get(realApp, `${root}/publish/${project.projectId}`, cookie!, bindings)).text();
      if (token) {
        const requests = calls.slice(start);
        expect(requests.some((call) => call.url.endsWith("/message/broadcast"))).toBe(true);
        expect(requests.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
      } else {
        expect(calls).toHaveLength(start);
        expect(record?.line_error).toBe(LINE_NOT_CONFIGURED);
        expect(html).toContain("送れませんでした。区のページには載っています。紙も配れます。");
      }
      for (const value of Object.values(secrets)) expect(html).not.toContain(value);
    }
    const channels = await env.DB.prepare("SELECT * FROM line_channels WHERE ward_id IN (?, ?)")
      .bind(first.ward.wardId, second.ward.wardId).all();
    expect(channels.results).toHaveLength(2);
    for (const value of Object.values(secrets)) expect(JSON.stringify(channels.results)).not.toContain(value);
  } finally {
    vi.unstubAllGlobals();
  }
});

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(Array.from(signature, (value) => String.fromCharCode(value)).join(""));
}

it("webhookの署名・返信・投稿者と写真の取得にも、その区の鍵だけを使う", async () => {
  const first = await openTestWard();
  const second = await openTestWard();
  if (!first.line || !second.line) throw new Error("架空のLINEの参照先がありません");
  const bindings = withEnv({
    [first.line.channelSecretBinding]: "fictional-secret-first", [first.line.accessTokenBinding]: "fictional-token-first",
    [second.line.channelSecretBinding]: "fictional-secret-second", [second.line.accessTokenBinding]: "fictional-token-second",
    LINE_CHANNEL_SECRET: "fictional-global-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-global-token",
  });
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/message/reply")) return new Response(null, { status: 200 });
    if (url.includes("/member/")) return Response.json({ displayName: "架空の投稿者" });
    if (url.endsWith("/content")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    throw new Error("この試験で予定していない外部通信です");
  };
  const ports: LineIntakePorts = {
    receiveOriginal: vi.fn(async () => null), matchInboxItem: vi.fn(async () => ({ disposition: "unmatched" as const })),
    assignProject: vi.fn(async () => undefined), discard: vi.fn(async () => undefined),
  };
  for (const [opened, secret, token, wrongSecret] of [
    [first, "fictional-secret-first", "fictional-token-first", "fictional-secret-second"],
    [second, "fictional-secret-second", "fictional-token-second", "fictional-secret-first"],
  ] as const) {
    const body = JSON.stringify({ destination: opened.destination, events: [
      { type: "join", webhookEventId: `join-${opened.ward.wardId}`, replyToken: "fictional-reply", source: { type: "group", groupId: "C-fictional-group" } },
      { type: "message", webhookEventId: `image-${opened.ward.wardId}`, source: { type: "group", groupId: "C-fictional-group", userId: "U-fictional-user" }, message: { type: "image", id: "fictional-image" } },
    ] });
    const request = async (key: string) => new Request("https://unit.test/hooks/line", {
      method: "POST", headers: { "x-line-signature": await sign(body, key) }, body,
    });
    const start = calls.length;
    expect((await acceptLineWebhook(await request(wrongSecret), bindings, env.DB, { fetch: fetcher, ports })).status).toBe(401);
    expect(calls).toHaveLength(start);
    expect((await acceptLineWebhook(await request(secret), bindings, env.DB, { fetch: fetcher, ports })).status).toBe(200);
    const requests = calls.slice(start);
    expect(requests).toHaveLength(3);
    expect(requests.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(ports.receiveOriginal).toHaveBeenCalledWith(opened.ward.wardId, expect.objectContaining({ kind: "image", senderDisplayName: "架空の投稿者" }));
  }
});
