import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin } from "../src/core/testing";
import { pendingMaterialGroups } from "../src/intake/groups";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getReadings, listOriginals } from "../src/intake/store";
import { applyChange, getProjectState } from "../src/project/api";
import { removeMapTask } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

it("新任の役員が題は案内・年不明の実際のフォームから送り、行事ごとに始め、質問と仕事が無くても下書きへ進める", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = JSON.parse(request.messages[0]!.content) as { originals: { original_id: string; filename: string }[]; text_blocks: { text: string }[] };
    expect(content.text_blocks.some((block) => block.text === "案内")).toBe(true);
    // モデルの通信だけを代える。資料は実際のフォーム、受付、R2、読み取りを通す。
    return Response.json({ id: "fixture-suggest", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ project_suggestions: content.originals.map((original) => ({
        original_id: original.original_id, title: original.filename === "当番.txt" ? FIRST_SLICE.dutyTitle : FIRST_SLICE.nextYearTitle,
        kind: original.filename === "当番.txt" ? "duty" : "event",
        date_text: original.filename === "案内.txt" ? "10月24日（土）" : "", place: original.filename === "案内.txt" ? FIRST_SLICE.previousPlace : "",
      })) }) }], usage: { input_tokens: 100, output_tokens: 50 } });
  } });
  setPipelineDeps({ createClient: () => client });
  setClientFactory(() => { throw new Error("試験から実際のAIへは接続しません"); });
  try {
    const main = await (await get(realApp, `${root}/`, cookie)).text();
    expect(main).toContain("去年の資料を送ってください");
    expect(main).toContain("資料がないので、種類を選んで始める");
    const formPage = await (await get(realApp, `${root}/intake`, cookie)).text();
    expect(formPage).toContain('name="project_id" value=""');
    expect(formPage).not.toContain('<select id="project_id"');

    const form = new FormData();
    form.set("project_id", "");
    form.append("part", new File([`案内\n${FIRST_SLICE.nextYearTitle}\n10月24日（土）\n${FIRST_SLICE.previousPlace}`], "案内.txt", { type: "text/plain" }));
    form.append("part", new File([`${FIRST_SLICE.nextYearTitle}\n${FIRST_SLICE.reportText}`], "報告.txt", { type: "text/plain" }));
    form.append("part", new File([FIRST_SLICE.dutyTitle], "当番.txt", { type: "text/plain" }));
    const accepted = await realApp.fetch(new Request(`http://localhost${root}/intake`, {
      method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form,
    }), env, ctx);
    expect(accepted.status).toBe(200);
    const received = await accepted.json() as { jobId: string; redirectTo: string };
    const receivedUrl = new URL(received.redirectTo, "http://localhost");
    expect(receivedUrl.origin).toBe("http://localhost");
    expect(receivedUrl.pathname).toBe(`${root}/intake/received`);
    expect(receivedUrl.searchParams.get("back")).toBe(`${root}/`);
    expect(receivedUrl.searchParams.has("project")).toBe(false);
    await Promise.all(tasks);
    expect(await (await get(realApp, `${root}/`, cookie)).text()).toContain("送った資料");
    expect(await (await get(realApp, received.redirectTo, cookie)).text()).toContain("受け取りました");
    const read = await (await get(realApp, `${root}/intake/read`, cookie)).text();
    expect(read).toContain(`${FIRST_SLICE.nextYearTitle}の資料のようです`);
    expect(read).not.toContain("案内の資料のようです");
    expect(read).toContain("10月24日（土）");
    const groups = await pendingMaterialGroups(env.DB, ward.wardId);
    const harvest = groups.find((g) => g.title === FIRST_SLICE.nextYearTitle);
    if (!harvest) throw new Error("行事の資料がまとまっていません");
    expect(harvest.materials).toHaveLength(2);
    expect(groups).toHaveLength(2);
    expect(await pendingMaterialGroups(env.DB, other.ward.wardId)).toHaveLength(0);
    const started = await postForm(realApp, `${root}/intake/start`, { group: harvest.key, eventDay: "" }, cookie);
    expect(started.status).toBe(303);
    const resultPath = started.headers.get("location");
    if (!resultPath) throw new Error("始めたあとの画面がありません");
    const id = resultPath.split("/").at(-1)!;
    const result = await (await get(realApp, resultPath, cookie)).text();
    expect(result).toContain("2件の資料を読んで、8つの仕事の段取りを用意しました");
    expect(result).toContain("案内の下書きを見る");
    const originals = await listOriginals(env.DB, ward.wardId, received.jobId);
    expect(originals.map((o) => o.filename)).toEqual(["当番.txt"]);
    const remaining = await pendingMaterialGroups(env.DB, ward.wardId);
    expect(remaining.map((g) => g.title)).toEqual([FIRST_SLICE.dutyTitle]);
    const moved = await env.DB.prepare("SELECT job_id, original_id FROM originals WHERE ward_id = ? AND filename = ?").bind(ward.wardId, "案内.txt").first<{ job_id: string; original_id: string }>();
    if (!moved) throw new Error("案内の元の資料がありません");
    const readings = await getReadings(env.DB, ward.wardId, moved.job_id);
    const body = readings[0]?.body;
    if (!body || !("original_years" in body)) throw new Error("元の資料ごとの読み取りがありません");
    expect(body.original_years.every((entry) => entry.year === null)).toBe(true);
    await applyChange(env.DB, ward.wardId, id, { kind: "item", itemKey: "place", value: FIRST_SLICE.previousPlace,
      source: { kind: "original", ref: moved.original_id, locator: "4行目" }, confidence: "high", packVersion: "connect@12" });
    const state = await getProjectState(env.DB, ward.wardId, id);
    if (!state) throw new Error("段取りがありません");
    expect(state.questions).toHaveLength(0);
    expect(state.items.find((item) => item.key === "place")?.current).toBeNull();
    expect(state.items.find((item) => item.key === "place")?.references).toHaveLength(1);
    for (const task of state.mapTasks) await removeMapTask(env.DB, ward.wardId, id, task.taskId);
    const noTasks = await (await get(realApp, `${root}/`, cookie)).text();
    expect(noTasks).toContain("仕事はまだありません。段取りから足せます");
    expect(await (await get(realApp, resultPath, cookie)).text()).toContain("案内の下書きを見る");
    expect((await get(realApp, `${root}/projects/${id}/draft/announcement`, cookie)).status).toBe(200);
  } finally {
    setPipelineDeps(null);
    setClientFactory(null);
  }
});

it("読み手ごとに題が揺れ、当番や役員会の資料が混ざっても、一度に送った資料は一つのまとまりになる", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, via, read_kind, sender_label, account_id, status, created_at, updated_at, read_at)
    VALUES (?, ?, 'admin', 'general', '架空', ?, 'read', ?, ?, ?)`).bind(jobId, ward.wardId, account.accountId, now, now, now).run();
  const ids = Array.from({ length: 5 }, (_, index) => `original-${index}`);
  for (const [index, id] of ids.entries()) {
    await env.DB.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, filename, kind, media_type, content_hash, byte_size, received_at)
      VALUES (?, ?, ?, ?, ?, 'text', 'text/plain', ?, 1, ?)`).bind(id, ward.wardId, jobId, index, `資料${index}.txt`, `hash-${index}`, now).run();
  }
  const body = (suggestions: { original_id: string; title: string; kind: string }[]) => JSON.stringify({
    document_kind: "other", summary: "", original_years: [], text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    project_suggestions: suggestions.map((s) => ({ ...s, date_text: "", place: "" })),
  });
  await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
    VALUES (?, ?, ?, 'direct', 'fixture@1', 'fixture', ?, ?), (?, ?, ?, 'model', 'fixture@1', 'fixture', ?, ?)`).bind(
    crypto.randomUUID(), ward.wardId, jobId, body([
      { original_id: ids[0]!, title: "収穫祭", kind: "event" }, { original_id: ids[1]!, title: "収穫祭", kind: "duty" },
    ]), now,
    crypto.randomUUID(), ward.wardId, jobId, body([
      { original_id: ids[2]!, title: "秋の収穫祭", kind: "event" }, { original_id: ids[3]!, title: "2025年度 秋の収穫祭", kind: "board_meeting" },
    ]), now,
  ).run();
  const groups = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ kind: "event" });
  expect(groups[0]!.materials).toHaveLength(5);
});
