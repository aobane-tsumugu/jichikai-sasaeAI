// Anthropic への入口（署名鍵 -> JWT -> トークン）と、読むの呼び出しの形を、ネットワーク無しで確かめる。
// 本物の API は npm test から呼ばない（実機の確かめは別に、少ない回数で行う）。
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AnthropicAuthError,
  base64urlDecode,
  base64urlEncode,
  exchangeFederationToken,
  getAccessToken,
  resetAnthropicAuthCache,
  signFederationJwt,
} from "../src/ai/anthropic";
import { buildContent, fixOriginalIds, readOriginals, ReadError, type ReadableOriginal } from "../src/ai/read";
import { buildMatchPrompt, buildMatchSchema, matchProject, MATCH_UNRELATED } from "../src/ai/match";
import { GENERAL_READING_SCHEMA, type Reading } from "../src/ai/schema";

async function makeKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey & { kid?: string };
  jwk.kid = "試験のkid";
  const raw = base64urlEncode(new TextEncoder().encode(JSON.stringify(jwk)));
  return { raw, publicKey: pair.publicKey };
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(part))) as Record<string, unknown>;
}

const IDS = {
  ANTHROPIC_FEDERATION_RULE_ID: "rule-1",
  ANTHROPIC_ORGANIZATION_ID: "org-1",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "sa-1",
  ANTHROPIC_WORKSPACE_ID: "ws-1",
};

beforeEach(() => resetAnthropicAuthCache());

describe("連携の JWT", () => {
  it("ES256 で署名し、決めた中身を持ち、毎回 jti が変わる", async () => {
    const { raw, publicKey } = await makeKey();
    const now = Date.UTC(2026, 10, 5, 0, 0, 0);
    const jwt = await signFederationJwt(raw, now);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(decodeJson(h)).toEqual({ alg: "ES256", typ: "JWT", kid: "試験のkid" });
    const claims = decodeJson(p);
    expect(claims).toMatchObject({
      iss: "https://issuer.jichikai-sasae.invalid",
      sub: "jichikai-sasae-worker",
      aud: "https://api.anthropic.com",
      iat: now / 1000,
      exp: now / 1000 + 300,
    });
    expect(typeof claims.jti).toBe("string");
    // r||s の 64 バイトで、公開鍵で検証できる
    const signature = base64urlDecode(s);
    expect(signature.length).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
    const second = decodeJson((await signFederationJwt(raw, now)).split(".")[1] as string);
    expect(second.jti).not.toBe(claims.jti);
  });

  it("鍵の形が違えば、中身を出さずに理由を言う", async () => {
    await expect(signFederationJwt("これは鍵ではない")).rejects.toBeInstanceOf(AnthropicAuthError);
    const pub = base64urlEncode(new TextEncoder().encode(JSON.stringify({ kty: "EC", crv: "P-256", kid: "k" })));
    await expect(signFederationJwt(pub)).rejects.toThrow("ES256");
  });
});

describe("トークンの交換", () => {
  it("決めた宛先と本文で送り、トークンを受ける", async () => {
    const { raw } = await makeKey();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const token = await exchangeFederationToken(
      { ANTHROPIC_FEDERATION_SIGNING_KEY: raw, ...IDS },
      async (url, init) => {
        calls.push({ url, init });
        return Response.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 600 });
      },
      Date.UTC(2026, 10, 5),
    );
    expect(token).toEqual({ token: "tok-1", expiresAt: Date.UTC(2026, 10, 5) / 1000 + 600 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["anthropic-beta"]).toBe("oidc-federation-2026-04-01");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, string>;
    expect(body).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      federation_rule_id: "rule-1",
      organization_id: "org-1",
      service_account_id: "sa-1",
      workspace_id: "ws-1",
    });
    expect(body.assertion?.split(".")).toHaveLength(3);
  });

  it("失敗は状態と種類だけを例外に出し、応答の説明文は出さない", async () => {
    const { raw } = await makeKey();
    const error = await exchangeFederationToken(
      { ANTHROPIC_FEDERATION_SIGNING_KEY: raw, ...IDS },
      async () => Response.json({ error: "invalid_grant", error_description: "秘密っぽい説明" }, { status: 401 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnthropicAuthError);
    expect((error as AnthropicAuthError).message).toContain("401 invalid_grant");
    expect((error as AnthropicAuthError).message).not.toContain("秘密っぽい");
  });

  it("切れる 1 分前までは使い回し、それを過ぎたら取り直す。同時の要求は一度にまとめる", async () => {
    const { raw } = await makeKey();
    let count = 0;
    const fetchImpl = async () => {
      count += 1;
      return Response.json({ access_token: `tok-${count}`, expires_in: 600 });
    };
    const env = { ANTHROPIC_FEDERATION_SIGNING_KEY: raw, ...IDS };
    const t0 = Date.UTC(2026, 10, 5);
    const [a, b] = await Promise.all([
      getAccessToken(env, { fetchImpl, nowMs: t0 }),
      getAccessToken(env, { fetchImpl, nowMs: t0 }),
    ]);
    expect(a.token).toBe("tok-1");
    expect(b.token).toBe("tok-1");
    expect(count).toBe(1);
    expect((await getAccessToken(env, { fetchImpl, nowMs: t0 + 500_000 })).token).toBe("tok-1");
    expect((await getAccessToken(env, { fetchImpl, nowMs: t0 + 541_000 })).token).toBe("tok-2");
    expect((await getAccessToken(env, { fetchImpl, nowMs: t0 + 541_000, forceRefresh: true })).token).toBe("tok-3");
  });
});

const original = (id: string, mediaType: string, size = 10): ReadableOriginal => ({
  originalId: id,
  filename: `${id}.bin`,
  mediaType,
  position: 1,
  bytes: new Uint8Array(size).fill(7),
});

function fakeClient(respond: (req: unknown) => unknown): { client: Anthropic; requests: unknown[] } {
  const requests: unknown[] = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        requests.push(req);
        const r = respond(req);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const emptyReading: Reading = {
  document_kind: "memo",
  original_years: [{ original_id: "o1", year: null }],
  summary: "要約",
  text_blocks: [{ original_id: "o1", locator: "1 枚目", text: "文" }],
  fields: [{ name: "日時", value: "10月25日", confidence: "high", original_id: "取り違えたID", locator: "上" }],
  tables: [],
  decisions: [],
  unreadable: [],
};

function message(text: string, stopReason = "end_turn") {
  return {
    model: "claude-sonnet-5-5",
    stop_reason: stopReason,
    content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: null },
  };
}

describe("読むの呼び出し", () => {
  it("原本ごとに ID の行と画像か PDF を並べ、型付きの出力を求める", async () => {
    const { client, requests } = fakeClient(() => message(JSON.stringify(emptyReading)));
    const result = await readOriginals(client, {
      kind: "general",
      originals: [original("o1", "image/jpeg"), original("o2", "application/pdf")],
    });
    const req = requests[0] as {
      model: string;
      max_tokens: number;
      output_config: { effort: string; format: { type: string; schema: unknown } };
      messages: Array<{ content: Array<{ type: string; text?: string; source?: { media_type: string } }> }>;
      thinking?: unknown;
    };
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.max_tokens).toBeGreaterThanOrEqual(16_000);
    expect(req.output_config.format).toEqual({ type: "json_schema", schema: GENERAL_READING_SCHEMA });
    expect(req.thinking).toBeUndefined();
    const types = req.messages[0]?.content.map((b) => b.type);
    expect(types).toEqual(["text", "image", "text", "document", "text"]);
    expect(req.messages[0]?.content[0]?.text).toContain("原本 ID: o1");
    expect(req.messages[0]?.content[3]?.source?.media_type).toBe("application/pdf");
    expect(result.packVersion).toBe("read-general@3");
    expect(result.usage).toEqual({ input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 });
    // 実在しない original_id は、原本が一つなら、その原本に直る
    const reading = result.body as Reading;
    expect(reading.fields[0]?.original_id).toBe("");
  });

  it("原本が一つだけなら、取り違えた original_id をその原本に直す", () => {
    const fixed = fixOriginalIds(emptyReading, ["o1"]) as Reading;
    expect(fixed.fields[0]?.original_id).toBe("o1");
    expect(fixed.text_blocks[0]?.original_id).toBe("o1");
  });

  it("画像が大きすぎれば呼ばずに失敗にする", () => {
    expect(() => buildContent([original("o1", "image/jpeg", 5 * 1024 * 1024 + 1)])).toThrow(ReadError);
    expect(() => buildContent([original("o1", "text/plain")])).toThrow("読めません");
  });

  it("断られた、長すぎた、JSON でない、の失敗を分ける", async () => {
    const run = (text: string, stop?: string) =>
      readOriginals(fakeClient(() => message(text, stop)).client, { kind: "general", originals: [original("o1", "image/png")] }).catch(
        (e: unknown) => e as ReadError,
      );
    expect(await run("{}", "refusal")).toMatchObject({ failure: "refused", retryable: false });
    expect(await run("{", "max_tokens")).toMatchObject({ failure: "too_large", retryable: false });
    expect(await run("これは JSON ではない")).toMatchObject({ failure: "error", retryable: true });
  });

  it("API の失敗は、再試行してよい物とそうでない物に分ける。本文は例外に入れない", async () => {
    const status = (n: number) => Object.assign(new Error("本文 秘密"), { status: n });
    const run = (err: Error) =>
      readOriginals(fakeClient(() => err).client, { kind: "general", originals: [original("o1", "image/png")] }).catch(
        (e: unknown) => e as ReadError,
      );
    expect(await run(status(400))).toMatchObject({ failure: "unreadable", retryable: false });
    expect(await run(status(529))).toMatchObject({ failure: "error", retryable: true });
    expect(await run(new Error("net"))).toMatchObject({ failure: "error", retryable: true });
    expect(((await run(status(529))) as ReadError).message).not.toContain("秘密");
  });

  it("回答票は回答票のスキーマと指示で読む", async () => {
    const { client, requests } = fakeClient(() => message(JSON.stringify({ summary: "", rows: [], unreadable: [] })));
    const result = await readOriginals(client, { kind: "answer_sheet", originals: [original("o1", "image/png")] });
    const req = requests[0] as { system: string; output_config: { format: { schema: { required: string[] } } } };
    expect(req.system).toContain("回答票");
    expect(req.output_config.format.schema.required).toContain("rows");
    expect(result.packVersion).toBe("read-answer-sheet@3");
  });
});

describe("当てる", () => {
  const candidates = [
    { id: "p-1", title: "秋の収穫祭", detail: "行事、10 月 24 日" },
    { id: "p-2", title: "防災訓練" },
  ];

  it("候補の ID と三つの決まった選択肢の列挙に縛り、haiku で一回だけ呼ぶ", async () => {
    const { client, requests } = fakeClient(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ choice: "p-1", reason: "収穫祭の日程の話です" }) }],
      usage: { input_tokens: 300, output_tokens: 40 },
    }));
    const result = await matchProject(client, { candidates, summary: "雨なら公民館で", senderLabel: "副会長" });
    expect(result).toEqual({ choice: "p-1", reason: "収穫祭の日程の話です", usage: { input_tokens: 300, output_tokens: 40 } });
    expect(requests).toHaveLength(1);
    const req = requests[0] as { model: string; output_config: { format: { schema: { properties: { choice: { enum: string[] } } } } } };
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.output_config.format.schema.properties.choice.enum).toEqual(["p-1", "p-2", "__new__", "__multiple__", "__unrelated__"]);
    expect(buildMatchSchema([]).properties.choice.enum).toEqual(["__new__", "__multiple__", "__unrelated__"]);
    expect(buildMatchPrompt({ candidates, summary: "要約", excerpt: "あ".repeat(5000) })).not.toContain("あ".repeat(2001));
  });

  it("候補に無い ID は受け付けない。候補の ID の不正も弾く", async () => {
    const wrong = fakeClient(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ choice: "p-9", reason: "" }) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await expect(matchProject(wrong.client, { candidates, summary: "x" })).rejects.toThrow("候補に無い");
    await expect(matchProject(wrong.client, { candidates: [{ id: "__new__", title: "x" }], summary: "x" })).rejects.toThrow("不正");
    await expect(matchProject(wrong.client, { candidates: [candidates[0] as (typeof candidates)[0], candidates[0] as (typeof candidates)[0]], summary: "x" })).rejects.toThrow("不正");
    expect(MATCH_UNRELATED).toBe("__unrelated__");
  });
});
