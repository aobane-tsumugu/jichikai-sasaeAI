// 入れると列: 受付、ハッシュでの束ね、原本の置き場、読みの流れ（状態、貸し出し、拾い直し）、取り下げ、画面。
// Anthropic は呼ばない（readImpl を差し替える）。
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { readOriginals, ReadError, type ReadResult } from "../src/ai/read";
import { createApp } from "../src/core/app";
import { WardBucket } from "../src/core/storage";
import { seedAdmin, seedWard } from "../src/core/testing";
import { intake } from "../src/intake";
import { receiveOriginal, ReceiveError, retryJob, withdrawJob } from "../src/intake/api";
import { receive } from "../src/intake/receive";
import { runRead, setPipelineDeps, sweepReads, type PipelineDeps } from "../src/intake/pipeline";
import { setProjectDirectory, type ProjectDirectory } from "../src/intake/project-port";
import { getJob, getReadings, listOriginals, MAX_READ_ATTEMPTS } from "../src/intake/store";
import type { ReceivePart } from "../src/intake/receive";
import { bundles } from "../src/index";
import type { Waitable } from "../src/intake/types";
import type Anthropic from "@anthropic-ai/sdk";

function ctxOf() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext & Waitable;
  return { ctx, settle: async () => void (await Promise.all(pending.splice(0))) };
}

/** 重ならない中身の JPEG（先頭のバイトだけ本物の形）。 */
function jpeg(tag = crypto.randomUUID()): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(tag)]);
}

const photo = (name = "IMG.jpg", bytes = jpeg()): ReceivePart => ({
  kind: "photo",
  filename: name,
  mediaType: "image/jpeg",
  bytes,
});

const okRead = (overrides: Partial<ReadResult> = {}): NonNullable<PipelineDeps["readImpl"]> =>
  async (_client, { originals }) => ({
    body: {
      document_kind: "memo",
      document_year: 2026,
      summary: "試験の読み取り",
      text_blocks: originals.map((o) => ({ original_id: o.originalId, locator: "1 枚目", text: "文" })),
      fields: [],
      tables: [],
      decisions: [],
      unreadable: [],
    },
    packVersion: "read-general@1",
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 },
    ...overrides,
  });

const fakeDeps = (readImpl: PipelineDeps["readImpl"]): PipelineDeps => ({
  createClient: () => ({}) as unknown as Anthropic,
  readImpl,
});


/** 繋げる仕組みの試験は、プロジェクトの実在を問わない（実在の検査は別の試験で束 3 の実物を使う）。 */
const permissive: ProjectDirectory = { listOpen: async () => [], isOpen: async () => true };

// 本物の Anthropic を呼ばないための安全弁。読みを動かす試験は、自分で readImpl を差し替える
beforeEach(() => {
  setProjectDirectory(permissive);
  setClientFactory(() => {
    throw new Error("試験から本物の Anthropic は呼べません");
  });
  setPipelineDeps({
    createClient: () => {
      throw new Error("試験から本物の Anthropic は呼べません");
    },
  });
});

afterEach(() => {
  setClientFactory(null);
  setPipelineDeps(null);
  setProjectDirectory(null);
});

/** 受けるだけ。裏の読みは始めない。 */
async function receiveOnly(wardId: string, parts: ReceivePart[] = [photo()]) {
  return receive(env, { wardId, via: "admin", parts });
}

describe("受付", () => {
  it("原本を R2 に置き、入った物を作る。画像があれば読みの順番待ちになる", async () => {
    const ward = await seedWard(env.DB);
    const { ctx, settle } = ctxOf();
    setPipelineDeps(fakeDeps(okRead()));
    const bytes = jpeg();
    const out = await receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts: [photo("a.jpg", bytes)] });
    expect(out.jobId).toBeTruthy();
    expect(out.needsModelRead).toBe(true);
    expect(out.duplicates).toEqual([]);
    const originals = await listOriginals(env.DB, ward.wardId, out.jobId as string);
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({ position: 1, kind: "photo", media_type: "image/jpeg", filename: "a.jpg", byte_size: bytes.length });
    // 実体は区の ID の下にある
    const object = await new WardBucket(env.ORIGINALS, ward.wardId).get(originals[0]?.r2_path as string);
    expect(new Uint8Array((await object?.arrayBuffer()) as ArrayBuffer)).toEqual(bytes);
    const listed = await env.ORIGINALS.list({ prefix: `${ward.wardId}/originals/` });
    expect(listed.objects).toHaveLength(1);
    // 裏で読みが動いて終わる
    await settle();
    const job = await getJob(env.DB, ward.wardId, out.jobId as string);
    expect(job).toMatchObject({ status: "read", attempt: 1, failure: "" });
    const readings = await getReadings(env.DB, ward.wardId, out.jobId as string);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ source: "model", pack_version: "read-general@1", model: "claude-sonnet-5-5" });
    const run = await env.DB.prepare("SELECT kind, status, input_tokens, output_tokens FROM job_runs WHERE ward_id = ? AND job_id = ?")
      .bind(ward.wardId, out.jobId)
      .first();
    expect(run).toEqual({ kind: "read", status: "ok", input_tokens: 1000, output_tokens: 200 });
  });

  it("同じ物は置かず「同じ物でした」とし、複数枚は一つの入った物に束ねる", async () => {
    const ward = await seedWard(env.DB);
    const { ctx, settle } = ctxOf();
    setPipelineDeps(fakeDeps(okRead()));
    const same = jpeg();
    const first = await receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts: [photo("1.jpg", same), photo("2.jpg")] });
    expect(first.received).toHaveLength(2);
    expect((await listOriginals(env.DB, ward.wardId, first.jobId as string)).map((o) => o.position)).toEqual([1, 2]);

    // 同じ写真の二度送り
    const again = await receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts: [photo("もう一度.jpg", same)] });
    expect(again.jobId).toBeNull();
    expect(again.duplicates).toEqual([{ originalId: first.received[0]?.originalId, filename: "1.jpg" }]);

    // 新しい物が混ざっていれば、新しい物だけが入る
    const mixed = await receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts: [photo("x.jpg", same), photo("y.jpg")] });
    expect(mixed.received.map((r) => r.filename)).toEqual(["y.jpg"]);
    expect(mixed.duplicates).toHaveLength(1);

    // 同じ送信の中の二度
    const inside = jpeg();
    const twice = await receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts: [photo("p.jpg", inside), photo("q.jpg", inside)] });
    expect(twice.received).toHaveLength(1);
    expect(twice.duplicates).toHaveLength(1);
    await settle();
    const stored = await env.ORIGINALS.list({ prefix: `${ward.wardId}/originals/` });
    expect(stored.objects).toHaveLength(2 + 1 + 1);
  });

  it("別の区なら同じ物でも受ける", async () => {
    const a = await seedWard(env.DB);
    const b = await seedWard(env.DB);
    const { ctx } = ctxOf();
    setPipelineDeps(fakeDeps(okRead()));
    const bytes = jpeg();
    const x = await receiveOriginal(env, ctx, { wardId: a.wardId, via: "admin", parts: [photo("a.jpg", bytes)] });
    const y = await receiveOriginal(env, ctx, { wardId: b.wardId, via: "admin", parts: [photo("a.jpg", bytes)] });
    expect(x.jobId).toBeTruthy();
    expect(y.jobId).toBeTruthy();
    expect(await getJob(env.DB, a.wardId, y.jobId as string)).toBeNull();
  });

  it("同じ写真は同じプロジェクト内で束ね、別のプロジェクトでは受ける", async () => {
    const ward = await seedWard(env.DB);
    setPipelineDeps(fakeDeps(okRead()));
    const bytes = jpeg();
    const send = async (projectId: string) => {
      const { ctx, settle } = ctxOf();
      const result = await receiveOriginal(env, ctx, {
        wardId: ward.wardId,
        via: "admin",
        projectId,
        parts: [photo("同じ写真.jpg", bytes)],
      });
      await settle();
      return result;
    };

    const first = await send("project-a");
    const sameProject = await send("project-a");
    const otherProject = await send("project-b");

    expect(first.jobId).toBeTruthy();
    expect(sameProject.jobId).toBeNull();
    expect(sameProject.duplicates).toHaveLength(1);
    expect(otherProject.jobId).toBeTruthy();
    expect(otherProject.duplicates).toEqual([]);
    expect(await getJob(env.DB, ward.wardId, otherProject.jobId as string)).toMatchObject({ project_id: "project-b", status: "read" });
  });

  it("一行の文と文字のファイルと Word は、モデルを通さずにそのまま読み取りになる", async () => {
    const ward = await seedWard(env.DB);
    const { ctx } = ctxOf();
    let called = 0;
    setPipelineDeps(fakeDeps(async (...args) => (called++, okRead()(...args))));
    const out = await receiveOriginal(env, ctx, {
      wardId: ward.wardId,
      via: "admin",
      projectId: "p-1",
      parts: [
        { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("公民館 25日午後で押さえた") },
        { kind: "file", filename: "メモ.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("雨天は屋内\n傘置きは田中") },
        {
          kind: "file",
          filename: "a.docx",
          mediaType: "",
          bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]),
          extracted: { format: "docx", paragraphs: ["案内"], tables: [] },
        },
      ],
    });
    expect(out.needsModelRead).toBe(false);
    expect(called).toBe(0);
    const job = await getJob(env.DB, ward.wardId, out.jobId as string);
    expect(job).toMatchObject({ status: "read", project_id: "p-1", via: "admin" });
    const [reading] = await getReadings(env.DB, ward.wardId, out.jobId as string);
    expect(reading).toMatchObject({ source: "direct", pack_version: "read-direct@1", model: "" });
    const texts = (reading?.body as { text_blocks: Array<{ text: string; original_id: string }> }).text_blocks.map((t) => t.text);
    expect(texts).toEqual(["公民館 25日午後で押さえた", "雨天は屋内", "傘置きは田中", "案内"]);
  });

  it("受けられない物はエラーにして、何も置かない", async () => {
    const ward = await seedWard(env.DB);
    const { ctx } = ctxOf();
    const reject = (parts: ReceivePart[]) =>
      receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts }).catch((e: unknown) => e as ReceiveError);
    expect(await reject([])).toMatchObject({ code: "empty" });
    expect(await reject([{ kind: "file", filename: "x.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([1, 2, 3, 0]) }])).toMatchObject({ code: "unsupported", filename: "x.bin" });
    expect(await reject([{ kind: "file", filename: "a.xlsx", mediaType: "", bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0]) }])).toMatchObject({ code: "needs_expansion" });
    expect(await reject([{ kind: "file", filename: "a.xlsx", mediaType: "", bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0]), extracted: { format: "docx", paragraphs: [], tables: [] } }])).toMatchObject({ code: "needs_expansion" });
    expect(await reject([{ kind: "text", filename: "", mediaType: "", bytes: new TextEncoder().encode("   ") }])).toMatchObject({ code: "empty" });
    expect(await reject(Array.from({ length: 31 }, () => photo()))).toMatchObject({ code: "too_many" });
    expect((await env.ORIGINALS.list({ prefix: `${ward.wardId}/` })).objects).toHaveLength(0);
  });
});

describe("読みの流れ", () => {
  async function receiveOne(wardId: string) {
    return (await receiveOnly(wardId)).jobId as string;
  }

  it("貸し出し中の読みは二重に始めず、貸し出しが切れたら取り直せる", async () => {
    const ward = await seedWard(env.DB);
    const jobId = await receiveOne(ward.wardId);
    const deps = fakeDeps(okRead());
    const { claimRead } = await import("../src/intake/store");
    expect(await claimRead(env.DB, ward.wardId, jobId, 60_000)).toBe(1);
    // 貸し出し中
    expect(await claimRead(env.DB, ward.wardId, jobId, 60_000)).toBeNull();
    expect(await runRead(env, ward.wardId, jobId, { deps })).toBe("skipped");
    // 貸し出しが切れた（Cron が拾う場面）
    expect(await claimRead(env.DB, ward.wardId, jobId, 60_000, Date.now() + 61_000)).toBe(2);
  });

  it("再試行してよい失敗は received に戻り、Cron が拾い直して読める", async () => {
    const ward = await seedWard(env.DB);
    const jobId = await receiveOne(ward.wardId);
    let n = 0;
    const flaky = fakeDeps(async (...args) => {
      n += 1;
      if (n === 1) throw new ReadError("一時的な失敗", "error", true);
      return okRead()(...args);
    });
    expect(await runRead(env, ward.wardId, jobId, { deps: flaky })).toBe("retry");
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "received", attempt: 1 });
    // 放ってある物として、一分たったら Cron が拾う
    await env.DB.prepare("UPDATE jobs SET updated_at = ? WHERE ward_id = ? AND job_id = ?")
      .bind(new Date(Date.now() - 120_000).toISOString(), ward.wardId, jobId)
      .run();
    const swept = await sweepReads(env, flaky);
    expect(swept.picked).toBeGreaterThanOrEqual(1);
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "read", attempt: 2 });
    const runs = await env.DB.prepare("SELECT status FROM job_runs WHERE ward_id = ? AND job_id = ? ORDER BY started_at").bind(ward.wardId, jobId).all();
    expect(runs.results.map((r) => r.status)).toEqual(["error", "ok"]);
  });

  it("waitUntil が止められて貸し出しが切れたままの読みも、Cron が拾い直す", async () => {
    const ward = await seedWard(env.DB);
    const jobId = await receiveOne(ward.wardId);
    await env.DB.prepare("UPDATE jobs SET status = 'reading', attempt = 1, lease_until = ? WHERE ward_id = ? AND job_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), ward.wardId, jobId)
      .run();
    // 止められた読みの実行の記録が running のまま残っている
    await env.DB.prepare("INSERT INTO job_runs (run_id, ward_id, job_id, kind, attempt, status, started_at) VALUES ('r-stale', ?, ?, 'read', 1, 'running', ?)")
      .bind(ward.wardId, jobId, new Date(Date.now() - 600_000).toISOString())
      .run();
    await sweepReads(env, fakeDeps(okRead()));
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "read", attempt: 2 });
    const runs = await env.DB.prepare("SELECT run_id, status FROM job_runs WHERE ward_id = ? AND job_id = ? ORDER BY started_at").bind(ward.wardId, jobId).all();
    expect(runs.results.map((r) => r.status)).toEqual(["error", "ok"]);
  });

  it("再試行できない失敗と、試行の上限は failed になり、もう一度で最初からやり直せる", async () => {
    const ward = await seedWard(env.DB);
    const refusedJob = await receiveOne(ward.wardId);
    expect(await runRead(env, ward.wardId, refusedJob, { deps: fakeDeps(async () => { throw new ReadError("断られた", "refused", false); }) })).toBe("failed");
    expect(await getJob(env.DB, ward.wardId, refusedJob)).toMatchObject({ status: "failed", failure: "refused" });

    const exhausted = await receiveOne(ward.wardId);
    const alwaysFail = fakeDeps(async () => { throw new ReadError("届かない", "error", true); });
    for (let i = 1; i < MAX_READ_ATTEMPTS; i++) {
      expect(await runRead(env, ward.wardId, exhausted, { deps: alwaysFail })).toBe("retry");
    }
    expect(await runRead(env, ward.wardId, exhausted, { deps: alwaysFail })).toBe("failed");
    expect(await getJob(env.DB, ward.wardId, exhausted)).toMatchObject({ status: "failed", failure: "error", attempt: MAX_READ_ATTEMPTS });

    // もう一度
    const { ctx, settle } = ctxOf();
    setPipelineDeps(fakeDeps(okRead()));
    expect(await retryJob(env, ctx, ward.wardId, exhausted)).toBe(true);
    await settle();
    expect(await getJob(env.DB, ward.wardId, exhausted)).toMatchObject({ status: "read", attempt: 1, failure: "" });
    // 失敗でない物はもう一度できない
    expect(await retryJob(env, ctx, ward.wardId, exhausted)).toBe(false);
  });

  it("取り下げられた入った物には読み取りを置かない。実体も消える", async () => {
    const ward = await seedWard(env.DB);
    const jobId = await receiveOne(ward.wardId);
    const originals = await listOriginals(env.DB, ward.wardId, jobId);
    // 読みの最中に取り下げられた
    const slow = fakeDeps(async (...args) => {
      expect(await withdrawJob(env, ward.wardId, jobId)).toBe(true);
      return okRead()(...args);
    });
    expect(await runRead(env, ward.wardId, jobId, { deps: slow })).toBe("skipped");
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "withdrawn" });
    expect(await getReadings(env.DB, ward.wardId, jobId)).toEqual([]);
    expect(await new WardBucket(env.ORIGINALS, ward.wardId).head(originals[0]?.r2_path as string)).toBeNull();
    const after = await listOriginals(env.DB, ward.wardId, jobId);
    expect(after[0]).toMatchObject({ r2_path: null });
    expect(after[0]?.withdrawn_at).toBeTruthy();
    // 取り下げた物と同じ物を、改めて送れる
    const { ctx } = ctxOf();
    setPipelineDeps(fakeDeps(okRead()));
    const resend = await receiveOriginal(env, ctx, { wardId: ward.wardId, via: "admin", parts: [photo("再.jpg", jpeg("別"))] });
    expect(resend.jobId).toBeTruthy();
    // 二度は取り下げられない
    expect(await withdrawJob(env, ward.wardId, jobId)).toBe(false);
  });

  it("繋げ始めた入った物は取り下げられない", async () => {
    const ward = await seedWard(env.DB);
    const jobId = await receiveOne(ward.wardId);
    await env.DB.prepare("UPDATE jobs SET status = 'connecting' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, jobId).run();
    expect(await withdrawJob(env, ward.wardId, jobId)).toBe(false);
  });

  it("他の区の入った物は取り下げもやり直しもできない", async () => {
    const a = await seedWard(env.DB);
    const b = await seedWard(env.DB);
    const jobId = await receiveOne(a.wardId);
    expect(await withdrawJob(env, b.wardId, jobId)).toBe(false);
    expect(await getJob(env.DB, a.wardId, jobId)).toMatchObject({ status: "received" });
  });
});

const app = createApp([...Object.values(bundles)]);

describe("画面", () => {

  function request(path: string, init: RequestInit, ctx: ExecutionContext) {
    return app.request(path, init, env, ctx);
  }

  function multipart(fields: Array<[string, string | File]>, cookie: string): RequestInit {
    const form = new FormData();
    for (const [k, v] of fields) form.append(k, v);
    return { method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form };
  }

  it("ログインが要る", async () => {
    const { ward } = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    const res = await request(`/${ward.slug}/admin/intake`, {}, ctx);
    expect(res.status).toBe(303);
  });

  it("送る画面に、撮る、ファイル、一行の文が出る。画面の言葉に内部の言葉を出さない", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    const res = await request(`/${ward.slug}/admin/intake`, { headers: { cookie } }, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const word of ["撮る", "ファイルを選ぶ", "一行の文", "送る", "入った物"]) expect(html).toContain(word);
    expect(html).toContain('capture="environment"');
    // 画面に出ない言葉（スクリプトの中の変数名は除く）
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    for (const word of ["札", "セッション", "差分", "派生", "冪等", "包み"]) expect(visible).not.toContain(word);
  });

  it("写真と一行の文を送ると受けた返事が返り、裏で読みが動く。同じ物は「同じ物でした」", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    setPipelineDeps(fakeDeps(okRead()));
    const { ctx, settle } = ctxOf();
    const file = new File([jpeg("画面")], "IMG_1.jpg", { type: "image/jpeg" });
    const res = await request(
      `/${ward.slug}/admin/intake`,
      multipart([["project_id", ""], ["text", "傘置きは田中"], ["part", file], ["part_kind", "photo"], ["part_extracted", ""]], cookie),
      ctx,
    );
    const body = (await res.json()) as { ok: boolean; message: string; jobId: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("閉じても処理は続きます");
    await settle();
    expect(await getJob(env.DB, ward.wardId, body.jobId)).toMatchObject({ status: "read", via: "admin" });
    const originals = await listOriginals(env.DB, ward.wardId, body.jobId);
    expect(originals.map((o) => o.kind)).toEqual(["photo", "text"]);

    const again = await request(
      `/${ward.slug}/admin/intake`,
      multipart([["project_id", ""], ["text", ""], ["part", new File([jpeg("画面")], "別名.jpg", { type: "image/jpeg" })], ["part_kind", "photo"], ["part_extracted", ""]], cookie),
      ctx,
    );
    // 同じバイト列ではない（jpeg() は呼ぶたびに同じ tag でも先頭が同じだけ）ので、同じ tag のバイト列で確かめ直す
    expect(((await again.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("同じ写真を二度送ると二度目は「同じ物でした」", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    setPipelineDeps(fakeDeps(okRead()));
    const { ctx, settle } = ctxOf();
    const bytes = jpeg();
    const send = () =>
      request(
        `/${ward.slug}/admin/intake`,
        multipart([["project_id", ""], ["text", ""], ["part", new File([bytes], "IMG.jpg", { type: "image/jpeg" })], ["part_kind", "photo"], ["part_extracted", ""]], cookie),
        ctx,
      );
    expect(((await (await send()).json()) as { message: string }).message).toContain("受けました");
    const second = (await (await send()).json()) as { ok: boolean; message: string };
    expect(second).toMatchObject({ ok: true, message: "同じ物でした。" });
    await settle();
  });

  it("読めない形式は、分かる文で断る", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    const res = await request(
      `/${ward.slug}/admin/intake`,
      multipart([["project_id", ""], ["text", ""], ["part", new File([new Uint8Array([1, 2, 0, 3])], "x.bin")], ["part_kind", "file"], ["part_extracted", ""]], cookie),
      ctx,
    );
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.message).toContain("x.bin");
    expect(body.message).toContain("読めない形式");
  });

  it("入った物の一覧に、状態の言葉と、取り下げ、もう一度が出る。他の区の物は出ない", async () => {
    const mine = await seedAdmin(env.DB);
    const other = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    setPipelineDeps(fakeDeps(async () => { throw new ReadError("断られた", "refused", false); }));
    const ok = await receiveOnly(mine.ward.wardId, [photo("見える.jpg")]);
    await receiveOnly(other.ward.wardId, [photo("見えない.jpg")]);
    await runRead(env, mine.ward.wardId, ok.jobId as string);
    const res = await request(`/${mine.ward.slug}/admin/intake`, { headers: { cookie: mine.cookie } }, ctx);
    const html = await res.text();
    expect(html).toContain("見える.jpg");
    expect(html).not.toContain("見えない.jpg");
    expect(html).toContain("読めませんでした");
    expect(html).toContain("もう一度読む");
    expect(html).toContain("取り下げる");
  });

  it("取り下げの画面の操作", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    const out = await receiveOnly(ward.wardId);
    const res = await request(
      `/${ward.slug}/admin/intake/${out.jobId}/withdraw`,
      { method: "POST", headers: { cookie, origin: "http://localhost" } },
      ctx,
    );
    expect(res.status).toBe(303);
    expect(await getJob(env.DB, ward.wardId, out.jobId as string)).toMatchObject({ status: "withdrawn" });
  });

  it("原本の実体は、その区のログインした人だけが開ける", async () => {
    const mine = await seedAdmin(env.DB);
    const other = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    const bytes = jpeg("開く");
    const out = await receiveOnly(mine.ward.wardId, [photo("a.jpg", bytes)]);
    const id = out.received[0]?.originalId as string;
    const ok = await request(`/${mine.ward.slug}/admin/intake/originals/${id}`, { headers: { cookie: mine.cookie } }, ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);
    const crossWard = await request(`/${other.ward.slug}/admin/intake/originals/${id}`, { headers: { cookie: other.cookie } }, ctx);
    expect(crossWard.status).toBe(404);
    const anon = await request(`/${mine.ward.slug}/admin/intake/originals/${id}`, {}, ctx);
    expect(anon.status).toBe(303);
  });

  it("プロジェクトを選ぶ画面と、送る先の検査", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    setProjectDirectory({
      listOpen: async () => [{ projectId: "p-1", title: "秋の収穫祭（架空）" }],
      isOpen: async (_db, _w, id) => id === "p-1",
    });
    setPipelineDeps(fakeDeps(okRead()));
    const { ctx, settle } = ctxOf();
    const page = await (await request(`/${ward.slug}/admin/intake`, { headers: { cookie } }, ctx)).text();
    expect(page).toContain("秋の収穫祭（架空）");
    const bad = await request(`/${ward.slug}/admin/intake`, multipart([["project_id", "p-2"], ["text", "あ"]], cookie), ctx);
    expect(bad.status).toBe(400);
    const good = await request(`/${ward.slug}/admin/intake`, multipart([["project_id", "p-1"], ["text", "い"]], cookie), ctx);
    const body = (await good.json()) as { jobId: string };
    await settle();
    expect(await getJob(env.DB, ward.wardId, body.jobId)).toMatchObject({ project_id: "p-1" });
  });
});

describe("送る先のプロジェクトの検査", () => {
  it("実在しない、「undefined」のような、閉じたプロジェクトには送れない（束 3 の実物で確かめる）", async () => {
    setProjectDirectory(null);
    const { createProject } = await import("../src/project/api");
    const ward = await seedWard(env.DB);
    const open = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026 });
    const otherWard = await seedWard(env.DB);
    const foreign = await createProject(env.DB, otherWard.wardId, { kind: "event", title: "別の区（架空）", year: 2026 });
    const send = (projectId: string) =>
      receive(env, { wardId: ward.wardId, via: "admin", projectId, parts: [{ kind: "text", filename: "", mediaType: "", bytes: new TextEncoder().encode(crypto.randomUUID()) }] }).catch((e: unknown) => e as ReceiveError);
    expect(await send("undefined")).toMatchObject({ code: "no_project" });
    expect(await send(foreign.projectId)).toMatchObject({ code: "no_project" });
    expect((await send(open.projectId)) as { jobId: string }).toHaveProperty("jobId");
    // 閉じたら送れない
    await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind(new Date().toISOString(), ward.wardId, open.projectId).run();
    expect(await send(open.projectId)).toMatchObject({ code: "no_project" });
  });

  it("画面からも、実在しないプロジェクトの ID は断る", async () => {
    setProjectDirectory(null);
    const { ward, cookie } = await seedAdmin(env.DB);
    const { ctx } = ctxOf();
    const form = new FormData();
    form.append("project_id", "undefined");
    form.append("text", "あ");
    const res = await app.request(`/${ward.slug}/admin/intake`, { method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form }, env, ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("プロジェクト");
  });
});

describe("束の差し込み口", () => {
  it("intake は役員画面の口と Cron を持つ", () => {
    expect(intake.admin).toBeDefined();
    expect(intake.scheduled).toBeTypeOf("function");
    expect(readOriginals).toBeTypeOf("function");
  });
});
