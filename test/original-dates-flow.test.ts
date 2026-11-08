import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { seedAccount, seedWard } from "../src/core/testing";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { receive } from "../src/intake/receive";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { fictionalDatedWord } from "./fixtures/original-dates";
import type { ItemKey } from "../src/project/model";
import { getWardAiLimits } from "../src/ops/metrics";
import { eraseSnapshotJob, WARD_TABLE_POLICY } from "../src/archive/snapshot";
import { answerOriginalReference } from "../src/project/apply";
import type { ReferenceConflictDetail } from "../src/project/questions-original-reference";

afterEach(() => setClientFactory(null));

function browserOffice() {
  const root: { __sendOffice?: { extractOffice: (bytes: Uint8Array) => Promise<unknown> } } = {};
  new Function("window", SEND_SCRIPT)(root);
  if (!root.__sendOffice) throw new Error("ブラウザのWordの読み取りがありません");
  return root.__sendOffice;
}

async function setup() {
  const ward = await seedWard(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "収穫祭", year: 2026 });
  const office = browserOffice();
  const send = async (value: string, modified?: string, filename = "新しさの分からない名前.docx") => {
    const bytes = await fictionalDatedWord(value, modified);
    const outcome = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin",
      parts: [{ kind: "file", filename, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes,
        extracted: await office.extractOffice(bytes) }] });
    const originalId = outcome.received[0]?.originalId;
    if (!originalId) throw new Error("試しのWordを受け取れませんでした");
    return originalId;
  };
  const apply = (ref: string, value: string, year = 2025, itemKey: ItemKey = "due", packVersion = "fictional-u89@1") =>
    applyChange(env.DB, ward.wardId, project.projectId, { kind: "item", itemKey, value,
      confidence: "high", packVersion, source: { kind: "original", ref, year, locator: "段落1" } });
  const state = () => getProjectState(env.DB, ward.wardId, project.projectId);
  return { ward, project, send, apply, state };
}

function mockComparison(newerId: () => string | null) {
  let calls = 0;
  let lastPrompt = "";
  const client = new Anthropic({ apiKey: "fictional-u89-not-a-key", maxRetries: 0, fetch: async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    lastPrompt = request.messages[0]!.content;
    return Response.json({ id: "fictional-u89", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 200, output_tokens: 100 },
      content: [{ type: "text", text: JSON.stringify({ descriptions: ["案内", "案内"],
        differences: ["返事の締切が10月5日と10月3日で違います", "抽選会があるかどうかも違います"],
        clues: ["締切が10月3日の案内には『変更しました』とあります", "4月の役員会のメモの『抽選会は取りやめ』と、抽選会の無い案内が合います"],
        newer: newerId(), assessment: newerId() ? "中身から見ると、締切が10月3日の案内の方が新しいようです。役員会のメモと合うためです。"
          : "中身からは、どちらが新しいか分かりません。" }) }],
    });
  } });
  setClientFactory(() => client);
  return { calls: () => calls, prompt: () => lastPrompt };
}

it("新しいWordを先、古いWordを後に送り、本文の見立てと保存日が一致すれば参考を保ち、同じ組を一度だけ比べる", async () => {
  const s = await setup();
  const newer = await s.send("10月3日", "2025-09-20T10:00:00Z", "見分けられないA.docx");
  const older = await s.send("10月5日", "2025-09-12T10:00:00Z", "見分けられないB.docx");
  const memo = await receive(env, { wardId: s.ward.wardId, projectId: s.project.projectId, via: "admin",
    parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("4月の役員会のメモ。抽選会は取りやめ。") }] });
  expect(memo.received).toHaveLength(1);
  const ai = mockComparison(() => newer);
  expect((await s.apply(newer, "10月3日")).status).toBe("applied");
  expect((await s.apply(older, "10月5日")).status).toBe("kept");
  const state = await s.state();
  const reference = state?.items.find((item) => item.key === "due")?.references[0];
  expect(reference?.content).toBe("10月3日");
  expect(reference?.source.locator).toContain("9月20日に保存した案内を取りました");
  expect(reference?.source.locator).toContain("役員会のメモ");
  expect(state?.questions).toHaveLength(0);
  expect(ai.prompt()).toContain("抽選会は取りやめ");
  expect(ai.prompt()).not.toContain("見分けられない");
  await s.apply(older, "10月5日", 2025, "due", "fictional-u89@2");
  await s.apply(newer, "抽選会なし", 2025, "content");
  await s.apply(older, "抽選会あり", 2025, "content");
  expect(ai.calls()).toBe(1);
  const usage = await getWardAiLimits(env.DB, s.ward.wardId);
  expect(usage.costCents).toBeGreaterThan(0);
  const date = await env.DB.prepare("SELECT document_date, document_date_source FROM originals WHERE ward_id = ? AND original_id = ?")
    .bind(s.ward.wardId, newer).first();
  expect(date).toMatchObject({ document_date: "2025-09-20T10:00:00Z", document_date_source: "office_modified" });
});

it("日付が片方無いときは違うところと手がかりと見立てを一度聞き、答える前も参考から下書きを保存できる", async () => {
  const s = await setup();
  const older = await s.send("10月5日", "2025-09-12T10:00:00Z", "latest.docx");
  const newer = await s.send("10月3日", undefined, "old.docx");
  const ai = mockComparison(() => newer);
  await s.apply(older, "10月5日");
  await s.apply(newer, "10月3日");
  await s.apply(newer, "10月3日", 2025, "due", "fictional-u89@2");
  const state = await s.state();
  expect(state?.questions).toHaveLength(1);
  const question = state!.questions[0]!;
  for (const text of ["9月12日に保存した案内", "抽選会", "変更しました", "役員会のメモ", "中身から見ると", "役員の画面", "届いた"]) expect(question.text).toContain(text);
  // 日付の無い方は、届いた日と送り方で呼ぶ。ファイル名では呼ばない
  expect(question.text).toMatch(/\d+月\d+日に役員の画面から届いた案内/);
  expect(question.text).not.toContain("日付の分からない");
  expect(question.text).not.toMatch(/latest|old\.docx/);
  expect(state?.items.find((item) => item.key === "due")?.references[0]?.content).toBe("10月3日");
  const { saveAIDraft } = await import("../src/project/actions");
  expect(await saveAIDraft(env.DB, s.ward.wardId, s.project.projectId, "announcement", "fictional-draft@1", {
    text: "収穫祭の返事は10月3日までです。", items: [{ key: "due", content: "10月3日" }],
    based_on_state_version: state!.project.stateVersion,
  })).toBe(true);
  expect(ai.calls()).toBe(1);
});

it("今年の食い違いは資料の日付と中身の手がかりを示して人に聞き、同じ組・同じ項目では問いを繰り返さない", async () => {
  const s = await setup();
  const a = await s.send("10月5日", "2026-09-12T10:00:00Z");
  const b = await s.send("10月3日", "2026-09-20T10:00:00Z");
  const ai = mockComparison(() => b);
  await s.apply(a, "10月5日", 2026);
  expect((await s.apply(b, "10月3日", 2026)).status).toBe("conflict");
  await s.apply(b, "10月3日", 2026, "due", "fictional-u89@2");
  const state = await s.state();
  expect(state?.questions).toHaveLength(1);
  for (const text of ["今年", "9月20日", "抽選会", "役員会のメモ", "中身から見ると"]) expect(state!.questions[0]!.text).toContain(text);
  expect(state?.items.find((item) => item.key === "due")?.current).toBeNull();
  expect(ai.calls()).toBe(1);
});

it("日付と見立てが食い違うときと分からないときは一度問い、同じ原本の読み直しと同じ中身には比較を呼ばない", async () => {
  const s = await setup();
  const a = await s.send("10月5日", "2025-09-20T10:00:00Z");
  const b = await s.send("10月3日", "2025-09-12T10:00:00Z");
  const ai = mockComparison(() => b);
  await s.apply(a, "10月5日");
  await s.apply(b, "10月3日");
  expect((await s.state())?.questions).toHaveLength(1);
  await s.apply(b, "10月4日", 2025, "due", "fictional-reread@1");
  expect((await s.state())?.items.find((item) => item.key === "due")?.references[0]?.content).toBe("10月4日");
  await s.apply(a, "10月4日", 2025, "due", "fictional-same@1");
  expect(ai.calls()).toBe(1);
  const unknown = await setup();
  const c = await unknown.send("10月5日", "2025-09-20T10:00:00Z");
  const d = await unknown.send("10月3日", "2025-09-12T10:00:00Z");
  mockComparison(() => null);
  await unknown.apply(c, "10月5日");
  await unknown.apply(d, "10月3日");
  const state = await unknown.state();
  expect(state?.questions).toHaveLength(1);
  expect(state?.questions[0]?.text).toContain("どちらが新しいか分かりません");
  expect(state?.items.find((item) => item.key === "due")?.references[0]?.content).toBe("10月5日");
});

it("比較の記録も区の写しと書き出しに含め、原本を消した写しには比較を残さない", () => {
  expect(WARD_TABLE_POLICY.find((entry) => entry.table === "original_comparisons")).toMatchObject({ snapshot: true, export: true, deletion: { cascade: "originals" } });
  const erased = eraseSnapshotJob({ format: 1, wardId: "fictional-ward", tables: {
    originals: [{ original_id: "fictional-a", job_id: "fictional-job" }],
    original_comparisons: [{ first_original_id: "fictional-a", second_original_id: "fictional-b", result: "試しの比較" }],
  } }, "fictional-ward", "fictional-job");
  expect(JSON.parse(erased!).tables.original_comparisons).toHaveLength(0);
});

it("去年の回答処理は参考だけを直し、今年の中身を保ち、選んだ役員を残す", async () => {
  const s = await setup();
  const account = await seedAccount(env.DB, s.ward.wardId, "試しの役員");
  const a = await s.send("10月5日");
  const b = await s.send("10月3日");
  mockComparison(() => b);
  await s.apply(a, "10月5日");
  await s.apply(b, "10月3日");
  const question = (await s.state())!.questions[0]!;
  expect(question).toBeDefined();
  const stored = await env.DB.prepare("SELECT detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ?")
    .bind(s.ward.wardId, s.project.projectId, question.questionId).first<{ detail: string }>();
  const detail = JSON.parse(stored!.detail) as ReferenceConflictDetail;
  const index = detail.originals!.findIndex((original) => original.originalId === a);
  expect(question.options).toEqual(detail.originals!.map((original) => original.description));
  expect(await answerOriginalReference(env.DB, s.ward.wardId, s.project.projectId, question.questionId, account.accountId, question.options![index]!)).toBe(true);
  const state = await s.state();
  expect(state?.items.find((item) => item.key === "due")?.references[0]?.content).toBe("10月5日");
  expect(state?.items.find((item) => item.key === "due")?.current).toBeNull();
  expect(state?.questions).toHaveLength(0);
  const row = await env.DB.prepare("SELECT answered_by_account_id FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ?")
    .bind(s.ward.wardId, s.project.projectId, question.questionId).first();
  expect(row).toMatchObject({ answered_by_account_id: account.accountId });
});

/** 構造化出力が受け付けない指定（配列の下限 2 以上、配列の上限、文字数、数の範囲）を探す。一つでもあると API は 400 を返す。 */
function unsupportedSchemaKeys(node: unknown, path = "schema"): string[] {
  if (!node || typeof node !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "minItems" && typeof value === "number" && value > 1) found.push(`${path}.minItems`);
    if (["maxItems", "minLength", "maxLength", "minimum", "maximum", "multipleOf"].includes(key)) found.push(`${path}.${key}`);
    // 型を並べた形（type: ["string", "null"]）と enum を一緒に使うと断られた（配備先で 400）。null は anyOf で書く。
    if (key === "type" && Array.isArray(value)) found.push(`${path}.type`);
    found.push(...unsupportedSchemaKeys(value, `${path}.${key}`));
  }
  return found;
}

it("二つの資料の比べは、構造化出力が受け付ける形の決まりだけで頼む", async () => {
  const s = await setup();
  const a = await s.send("10月5日");
  const b = await s.send("10月3日");
  let schema: unknown = null;
  setClientFactory(() => new Anthropic({ apiKey: "fictional-schema-not-a-key", maxRetries: 0, fetch: async (_url, init) => {
    schema = (JSON.parse(String(init?.body)) as { output_config?: { format?: { schema?: unknown } } }).output_config?.format?.schema;
    return Response.json({ id: "fictional-schema", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: JSON.stringify({ descriptions: ["案内", "案内"], differences: ["締切が違います"],
        clues: ["手がかりはありません"], newer: null, assessment: "中身からは、どちらが新しいか分かりません。" }) }] });
  } }));
  await s.apply(a, "10月5日");
  await s.apply(b, "10月3日");
  expect(schema).not.toBeNull();
  expect(unsupportedSchemaKeys(schema)).toEqual([]);
});

it("比べの頼みが断られても、仕組みの事情を役員に見せず、二つの値を示して聞く", async () => {
  const s = await setup();
  const a = await s.send("10月5日");
  const b = await s.send("10月3日");
  setClientFactory(() => new Anthropic({ apiKey: "fictional-reject-not-a-key", maxRetries: 0, fetch: async () =>
    Response.json({ type: "error", error: { type: "invalid_request_error", message: "試しの断り" } }, { status: 400 }) }));
  await s.apply(a, "10月5日");
  await s.apply(b, "10月3日");
  const text = (await s.state())!.questions[0]!.text;
  expect(text).toContain("「10月5日」");
  expect(text).toContain("「10月3日」");
  expect(text).toContain("どちらが最後の資料かは、中身からは分かりませんでした。");
  expect(text).not.toMatch(/AI|手がかりを確認できていません/);
});
