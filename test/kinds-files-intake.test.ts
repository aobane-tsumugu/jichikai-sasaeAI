/// <reference types="vite/client" />
import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import { meetingMaterial } from "../scripts/walkthrough-meeting";
import { setClientFactory } from "../src/ai/deps";
import { setWorkersRoute } from "../src/ai/session";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { buildDirectReading } from "../src/intake/direct-reading";
import { sha256Hex } from "../src/intake/media";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getJob, getReadings, listOriginals } from "../src/intake/store";
import { createProject } from "../src/project/api";
import type { ProjectKind } from "../src/project/model";
import { kindsMaterial } from "./fixtures/kinds";
import { KIND_FILES, KINDS_FIXTURE_YEAR, MEETING_FIXTURE_NOW, kindFilesForm } from "./fixtures/kinds-files";
import type { KindFileGroup } from "./fixtures/kinds-files";
import { get, realApp } from "./helpers";

// 実ファイルを読み込む。試験用の別のWord・Excelは作らない。
const assets = import.meta.glob<string>("../fixtures/kinds/**/*.{docx,xlsx,pdf,jpg}", {
  eager: true, query: "?url&inline", import: "default",
});

it("U35: 全種類の実ファイル12点を、送る画面と同じ展開・multipartの受付・保管・偽AIの読み取りへ通す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const k = kindsMaterial(KINDS_FIXTURE_YEAR);
  const m = meetingMaterial(new Date(MEETING_FIXTURE_NOW));
  const groups: { group: KindFileGroup; kind: ProjectKind; year: number }[] = [
    { group: "meetingAgenda", kind: "general_meeting", year: m.year },
    { group: "meetingMinutes", kind: "general_meeting", year: m.year },
    { group: "boardAgenda", kind: "board_meeting", year: k.year },
    { group: "boardMinutes", kind: "board_meeting", year: k.year },
    { group: "boardNextMinutes", kind: "board_meeting", year: k.year },
    { group: "duty", kind: "duty", year: k.year - 1 },
    { group: "city", kind: "city_request", year: k.year },
  ];
  const paths = Object.values(KIND_FILES).flat();
  expect(paths).toHaveLength(12);
  expect(Object.keys(assets).sort()).toEqual(paths.map(path => "../fixtures/kinds/" + path).sort());
  const load = async (path: string) => {
    const url = assets["../fixtures/kinds/" + path];
    if (!url) throw new Error("試しの資料の実ファイルがありません: " + path);
    const base64 = /^data:[^,]*;base64,(.+)$/.exec(url)?.[1];
    if (!base64) throw new Error("試しの資料をバイトに戻せません");
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  };
  const pictureText: Record<string, string> = {
    "前回の総会の議事録.jpg": (m.year - 1) + "年1月6日10時、集会室。\n前回の記録です。今年の決定ではありません。",
    "今年の総会の記録.jpg": m.minutes,
    "議題の紙.jpg": k.agenda,
    "掲示の当番表.jpg": k.duty,
    "市の通知.pdf": k.city,
  };
  let reads = 0, connections = 0;
  // 接続は受付のあとまで進めるだけ。決定や下書きの正しさを証明する応答ではない。
  const client = new Anthropic({ apiKey: "fixture-u35-not-a-real-key", maxRetries: 0, fetch: async () => {
    connections++;
    return Response.json({
      id: "fixture-u35", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "試しの資料の受付の確認を終えました。" }],
    });
  } });
  await setWorkersRoute(env.DB, ward.wardId, true);
  setClientFactory(() => client);
  setPipelineDeps({
    createClient: () => client,
    readImpl: async (_client, { originals }) => {
      reads++;
      const body = buildDirectReading(originals.map(original => {
        const text = pictureText[original.filename];
        if (!text) throw new Error("偽AIが読む試しの資料がありません: " + original.filename);
        return { originalId: original.originalId, text };
      }));
      body.summary = "試しの紙と通知の偽の読み取りです";
      body.original_years = originals.map(original => ({
        original_id: original.originalId,
        year: original.filename === "前回の総会の議事録.jpg" ? m.year - 1 :
          original.filename === "今年の総会の記録.jpg" ? m.year :
          original.filename === "掲示の当番表.jpg" ? k.year - 1 : k.year,
      }));
      return { body, packVersion: "fixture-u35@1", model: "fixture-u35",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
    },
  });
  const contexts: ReturnType<typeof createExecutionContext>[] = [];
  let accepted = 0;
  try {
    for (const entry of groups) {
      const project = await createProject(env.DB, ward.wardId, {
        kind: entry.kind, year: entry.year, title: "試しの資料の受付の確認",
      });
      const root = "/" + ward.slug + "/admin/intake";
      const page = await get(realApp, root + "?project=" + project.projectId, cookie);
      expect(page.status).toBe(200);
      const form = await kindFilesForm(project.projectId, entry.group, load, await page.text());
      const parts = form.getAll("part");
      expect(parts).toHaveLength(KIND_FILES[entry.group].length);
      // 中身は手作りの読み取りで代えず、画面の処理で得た語を確認する。
      const extracted = form.getAll("part_extracted").join("\n");
      if (entry.group === "meetingAgenda") for (const word of [m.date, m.due, "清掃活動", "遊具", "ささえ台自治会"]) expect(extracted).toContain(word);
      if (entry.group === "boardMinutes") for (const word of [k.decision, k.pending]) expect(extracted).toContain(word);
      if (entry.group === "boardNextMinutes") expect(extracted).toContain(k.nextDecision);
      if (entry.group === "duty") for (const word of [...k.slots, k.task, k.names.retained, k.names.exempt, k.names.departed]) expect(extracted).toContain(word);
      if (entry.group === "city") for (const word of ["地域担当窓口", k.year + "年3月31日", "照明の数", "交換の希望の有無"]) expect(extracted).toContain(word);
      for (const [index, path] of KIND_FILES[entry.group].entries()) {
        const part = parts[index];
        if (typeof part === "string" || !part) throw new Error("送る元のファイルがありません");
        const bytes = await load(path);
        expect(await sha256Hex(new Uint8Array(await part.arrayBuffer()))).toBe(await sha256Hex(bytes));
        const signature = [...bytes.slice(0, 4)];
        expect(signature).toEqual(path.endsWith(".jpg") ? [255, 216, 255, 224] :
          path.endsWith(".pdf") ? [37, 80, 68, 70] : [80, 75, 3, 4]);
      }
      const ctx = createExecutionContext();
      contexts.push(ctx);
      const response = await realApp.fetch(new Request("http://localhost" + root, {
        method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form,
      }), env, ctx);
      expect(response.status).toBe(200);
      const result = await response.json() as { ok: boolean; jobId?: string };
      expect(result.ok).toBe(true);
      if (!result.jobId) throw new Error("資料の受付が記録されていません");
      await waitOnExecutionContext(ctx);
      expect(await getJob(env.DB, ward.wardId, result.jobId)).toMatchObject({ status: "done", failure: "" });
      const originals = await listOriginals(env.DB, ward.wardId, result.jobId);
      expect(originals.map(row => row.filename)).toEqual(KIND_FILES[entry.group].map(path => path.split("/").at(-1)));
      const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
      for (const [index, row] of originals.entries()) {
        const object = await bucket.get(row.r2_path!);
        if (!object) throw new Error("元の資料が保管されていません");
        expect(await sha256Hex(new Uint8Array(await object.arrayBuffer()))).toBe(await sha256Hex(await load(KIND_FILES[entry.group][index]!)));
      }
      const readings = await getReadings(env.DB, ward.wardId, result.jobId);
      expect(readings.length).toBeGreaterThan(0);
      for (const reading of readings) {
        if (!("text_blocks" in reading.body)) throw new Error("資料の読み取りの形が違います");
        const text = reading.body.text_blocks.map(block => block.text).join("\n") + JSON.stringify(reading.body.tables);
        const expectedWords: Record<KindFileGroup, readonly string[]> = {
          meetingAgenda: reading.source === "direct"
            ? [m.date, m.due, "清掃活動", "遊具", "ささえ台自治会"]
            : [(m.year - 1) + "年1月6日10時", "集会室", "今年の決定ではありません"],
          meetingMinutes: [m.date, m.decision, "遊具"],
          boardAgenda: [k.year + "年1月10日", "清掃用具", "遊具"],
          boardMinutes: [k.decision, k.pending], boardNextMinutes: [k.nextDecision],
          duty: [...k.slots, k.task, k.names.retained, k.names.exempt, k.names.departed],
          city: ["地域担当窓口", k.year + "年3月31日", "照明の数", "交換の希望の有無"],
        };
        for (const word of expectedWords[entry.group]) expect(text).toContain(word);
      }
      accepted += originals.length;
    }
    expect(accepted).toBe(12);
    expect(reads).toBe(5);
    expect(connections).toBeGreaterThanOrEqual(groups.length);
  } finally {
    await Promise.allSettled(contexts.map(ctx => waitOnExecutionContext(ctx)));
    setPipelineDeps(null);
    setClientFactory(null);
  }
}, 30_000);
