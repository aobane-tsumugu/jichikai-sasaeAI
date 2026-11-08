import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { joinOpenProjects, pendingMaterialGroups } from "../src/intake/groups";
import { setPipelineDeps } from "../src/intake/pipeline";
import { receive } from "../src/intake/receive";
import { getJob, getReadings, listOriginals } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("前提 1: 一度に送った資料のうち、名前の合う準備中のものの分は押さなくても入り、合わない分は読み終わったものに残る。始める時に種類を聞かない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの秋の収穫祭", year: 2026, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: null, via: "admin", parts: [
    { kind: "text", filename: "収穫祭の案内.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("試しの秋の収穫祭の案内") },
    { kind: "text", filename: "訓練の案内.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("試しの防災の集まりの案内") },
  ] });
  if (!got.jobId) throw new Error("試しの資料を受け付けられませんでした");
  const originals = await listOriginals(env.DB, ward.wardId, got.jobId);
  const [harvest, drill] = originals;
  if (!harvest || !drill) throw new Error("試しの原本がありません");
  const body = { document_kind: "notice", original_years: [], summary: "試しの二つの案内", text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    project_suggestions: [
      { original_id: harvest.original_id, title: "秋の収穫祭", kind: "event", date_text: "", place: "" },
      { original_id: drill.original_id, title: "試しの防災の集まり", kind: "event", date_text: "", place: "" },
    ] };
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now, ward.wardId, got.jobId).run();
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'test@1', 'fixture', ?, ?)")
    .bind(crypto.randomUUID(), ward.wardId, got.jobId, JSON.stringify(body), now).run();

  expect(await joinOpenProjects(env, ward.wardId, got.jobId)).toEqual([project.projectId]);
  // 収穫祭の分は準備に入り、名前の合わない分だけが読み終わったものに残る
  const placed = await env.DB.prepare("SELECT o.original_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND j.project_id = ?")
    .bind(ward.wardId, project.projectId).all<{ original_id: string }>();
  expect(placed.results.map((row) => row.original_id)).toEqual([harvest.original_id]);
  const left = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(left.map((group) => group.title)).toEqual(["試しの防災の集まり"]);
  // トップは、まだ始めていない予定の資料として書き、どの準備に入れるかとは聞かない
  const top = await (await get(realApp, `${root}/`, cookie)).text();
  expect(top).toContain("「試しの防災の集まり」の資料を、AIが読み終わりました。まだ準備を始めていません。");
  expect(top).not.toContain("準備に入れられそうな資料");
  // 残った分を新しく始める時も、種類は聞かない
  const read = await (await get(realApp, `${root}/intake/read`, cookie)).text();
  expect(read).toContain("この資料は、次の準備のものですか？");
  expect(read).not.toContain("<legend>種類</legend>");
  expect(read).not.toContain('name="kind"');
});

it("Word、Excel、PowerPointは古い形式も選べ、送る画面で案内する。パソコンからファイルを落として送れる", async () => {
  const { SEND_SCRIPT } = await import("../src/intake/browser-script");
  const { ward, cookie } = await seedAdmin(env.DB);
  const page = await (await get(realApp, `/${ward.slug}/admin/intake`, cookie)).text();
  expect(page).toContain(".doc,.xls");
  expect(page).toContain(".pptx");
  expect(page).toContain(".doc,.xls,.ppt");
  expect(page).toContain("写真、PDF、Word、Excel、PowerPoint（古い形式の.docや.xls、.pptも）を送れます。");
  expect(page).toContain('id="drop-zone"');
  expect(page).toContain("一度に30点、一つ25MB、合わせて80MBまでです。");
  expect(SEND_SCRIPT).not.toContain("古い形式のWordやExcelなので");
  expect(SEND_SCRIPT).toContain("var SEND_LIMITS = { parts: 30, file: 26214400, total: 83886080 };");
});

it.each(["doc", "xls"])("古い形式の%sは選べ、壊れていても原本と読めなかった理由を残す", async (format) => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const page = await (await get(realApp, `${root}/intake`, cookie)).text();
  expect(page).toContain(".doc,.xls");
  const form = new FormData();
  form.set("project_id", "");
  const filename = `試しの資料.${format}`;
  const mediaType = format === "doc" ? "application/msword" : "application/vnd.ms-excel";
  const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
  form.append("part", new File([bytes], filename, { type: mediaType }));
  form.append("part_kind", "file");
  // 題の見立てだけを試しの応答に替え、受付・原本保存・読み取りは実物を通す。
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async () => Response.json({
    id: "fixture-suggestions", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify({ project_suggestions: [], ward_facts: [], year_entries: [] }) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }) });
  const pending: Promise<unknown>[] = [];
  setPipelineDeps({ createClient: () => client });
  try {
    const response = await realApp.fetch(new Request(`http://localhost${root}/intake`, { method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form }), env,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => undefined, props: {} });
    expect(response.status).toBe(200);
    const result = await response.json() as { ok: boolean; message: string; jobId: string };
    expect(result.ok).toBe(true);
    expect(result.message).toContain("受け取りました。");
    expect(result.jobId).toBeTruthy();
    await Promise.all(pending);
    expect((await getJob(env.DB, ward.wardId, result.jobId))?.status).toBe("read");
    const originals = await listOriginals(env.DB, ward.wardId, result.jobId);
    expect(originals).toHaveLength(1);
    const original = originals[0];
    expect(original).toMatchObject({ filename, media_type: mediaType, byte_size: bytes.length });
    if (!original?.r2_path) throw new Error("壊れた資料の保存先がありません");
    const stored = await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path);
    expect(stored && new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
    expect(await getReadings(env.DB, ward.wardId, result.jobId)).toMatchObject([
      { source: "direct", body: { text_blocks: [], tables: [], unreadable: [
        { original_id: original.original_id, note: expect.stringContaining("元の資料は預かりましたが、本文を読み取れませんでした。") },
      ] } },
    ]);
  } finally {
    await Promise.all(pending);
    setPipelineDeps(null);
  }
});
