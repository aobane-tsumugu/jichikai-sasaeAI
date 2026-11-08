import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getReadings, listOriginals } from "../src/intake/store";
import { compound, wordStreams, workbookStream } from "./fixtures/legacy-office";
import { get, realApp } from "./helpers";

afterEach(() => setPipelineDeps(null));

it.each(["txt", "doc", "xls"])("行事未定の%sをブラウザから送ると、受け取った画面へ進んでその資料が出る", async (format) => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const form = {
    dataset: {},
    action: `${root}/intake`, elements: { text: { value: "" }, project_id: { value: "" } }, reset: vi.fn(),
    addEventListener: (_name: string, listener: typeof submit) => { submit = listener; },
  };
  const status = { textContent: "", className: "" };
  const button = { disabled: false };
  const bytes = format === "doc" ? compound(wordStreams("試しの市の通知です。\r"))
    : format === "xls" ? compound({ Workbook: workbookStream() }) : new TextEncoder().encode("試しの市の通知です。");
  const mediaType = format === "doc" ? "application/msword" : format === "xls" ? "application/vnd.ms-excel" : "text/plain";
  const file = new File([bytes], `試しの通知.${format}`, { type: mediaType });
  const elements = new Map<string, unknown>([
    ["send-form", form], ["send-status", status], ["send-button", button], ["files", { files: [file] }],
  ]);
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector !== "form[data-photo-form]") throw new Error(`試験のDOMで扱っていない選択です: ${selector}`);
      // 送る画面のフォームにはdata-photo-formが無い。写真専用フォームと区別して探す。
      return [form].filter((candidate) => "photoForm" in candidate.dataset);
    },
  };
  const location = { assign: vi.fn(), reload: vi.fn() };
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async () => Response.json({
    id: "fixture-suggestions", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify({ project_suggestions: [], ward_facts: [], year_entries: [] }) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }) });
  setPipelineDeps({ createClient: () => client });
  const send = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("origin", "http://localhost");
    headers.set("cookie", cookie);
    const pending: Promise<unknown>[] = [];
    const response = await realApp.fetch(new Request(new URL(path, "http://localhost"), { ...init, headers }), env,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => undefined, props: {} });
    await Promise.all(pending);
    expect(response.status).toBe(200);
    return response;
  };
  new Function("window", "document", "fetch", "location", "setTimeout", SEND_SCRIPT)(
    {}, document, send, location, (callback: () => void) => { callback(); },
  );
  expect(submit).toBeDefined();
  await submit!({ preventDefault: vi.fn() });
  expect(location.assign).toHaveBeenCalledExactlyOnceWith(`${root}/intake/received?${new URLSearchParams({ back: `${root}/` })}`);
  expect(location.reload).not.toHaveBeenCalled();
  const destination: unknown = location.assign.mock.calls[0]?.[0];
  if (typeof destination !== "string") throw new Error("受け取ったあとの画面がありません");
  const inbox = await get(realApp, destination, cookie);
  expect(inbox.status).toBe(200);
  const inboxHtml = await inbox.text();
  expect(inboxHtml).toContain(file.name);
  expect(inboxHtml).toContain(`href="${root}/"`);
  const original = await env.DB.prepare("SELECT job_id FROM originals WHERE ward_id = ? AND filename = ?")
    .bind(ward.wardId, file.name).first<{ job_id: string }>();
  if (!original) throw new Error("ブラウザから送った資料がありません");
  expect(await listOriginals(env.DB, ward.wardId, original.job_id)).toMatchObject([{ filename: file.name, media_type: mediaType }]);
  const readings = await getReadings(env.DB, ward.wardId, original.job_id);
  expect(readings).toHaveLength(1);
  expect(readings[0]?.body).toMatchObject(format === "xls"
    ? { tables: [{ name: "協賛先", rows: [{ cells: ["相手", "額"] }, { cells: ["商店A", "6000"] }, { cells: ["", "", "", "2026-10-24"] }] }], unreadable: [] }
    : { text_blocks: [{ text: "試しの市の通知です。" }], unreadable: [] });
});
