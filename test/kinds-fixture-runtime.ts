// meeting-fixture-runtimeと同じ方式。本体の受付・MCP・保存を通し、AIへの通信だけを偽物にする。
import Anthropic from "@anthropic-ai/sdk";
import { setClientFactory } from "../src/ai/deps";
import { setWorkersRoute } from "../src/ai/session";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getDraftPack } from "../src/draft/packs";
import type { Env } from "../src/env";
import type { ProjectState } from "../src/project/types";
import { SETTING_KEYS } from "../src/settings/keys";
import { setSetting } from "../src/settings/store";
import { kindsMaterial } from "./fixtures/kinds";

interface ToolResult { type: string; content?: string; is_error?: boolean; tool_use_id?: string; }
interface AIRequest { messages: { role: string; content: string | ToolResult[] }[]; }

export async function prepareKindsRuntime(env: Env) {
  const seeded = await seedAdmin(env.DB);
  await setWorkersRoute(env.DB, seeded.ward.wardId, true);
  // 班名は本番の道具では画面から取る。ここはその画面に選びを用意する。
  await setSetting(env.DB, seeded.ward.wardId, SETTING_KEYS.squads, JSON.stringify(["架空東の班", "架空西の班"]), seeded.account.accountId);
  let calls = 0, drafts = 0, connections = 0;
  const source = kindsMaterial();
  const client = new Anthropic({ apiKey: "fictional-u51-ai", maxRetries: 0, fetch: async (input, init) => {
    if (!String(input).endsWith("/v1/messages")) throw new Error("架空のMessages以外への通信です");
    calls++;
    const request = JSON.parse(String(init?.body)) as AIRequest;
    const first = request.messages[0]?.content;
    if (typeof first !== "string") throw new Error("架空のAIに指示がありません");
    const ticket = /^札: (.+)$/m.exec(first)?.[1];
    if (!ticket) throw new Error("架空のAIに書き込み先がありません");
    const response = (content: unknown, stopReason: string) => Response.json({
      id: "msg_fictional_u51", type: "message", role: "assistant", model: "fictional-u51",
      content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    });
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "tool_use", id, name, input: { ...args, ticket } });
    const connect = /^仕事: connect$/m.test(first);
    if (request.messages.length === 1) return response([
      call("fixture_state", "get_project_state", {}), ...(connect ? [call("fixture_reading", "get_reading", {})] : []),
    ], "tool_use");
    const last = request.messages.at(-1)?.content;
    if (!Array.isArray(last)) throw new Error("架空のAIに道具の答えがありません");
    for (const result of last) {
      if (result.is_error) throw new Error("架空のAIの道具が失敗しました");
      if (result.tool_use_id?.startsWith("fixture_write") && !/"status":"(?:applied|added)"/.test(result.content ?? "")) {
        throw new Error("架空のAIが頼んだ書き込みが保存されていません");
      }
    }
    if (request.messages.length === 3) {
      const state = JSON.parse(last.find(r => r.tool_use_id === "fixture_state")?.content ?? "null") as ProjectState;
      if (!state?.project) throw new Error("架空のAIに仕事の状態がありません");
      if (connect) {
        connections++;
        const material = JSON.parse(last.find(r => r.tool_use_id === "fixture_reading")?.content ?? "null") as { readings: { body: Reading }[] };
        const blocks = material.readings.flatMap(r => r.body.text_blocks);
        if (!blocks.length) throw new Error("架空のAIに送った資料がありません");
        const writes = [];
        for (const [index, block] of blocks.entries()) {
          const origin = { original_id: block.original_id, locator: block.locator, confidence: "high" };
          if ([source.decision, source.nextDecision].some(decision => block.text === decision + "。")) {
            writes.push(call(`fixture_write_${index}`, "write_change", { ...origin, kind: "decision", target: "decisions", data: { what: block.text.replace(/。$/, "") } }));
          }
          if (block.text === source.pending + "。") writes.push(call(`fixture_write_question_${index}`, "write_question", { ...origin, kind: "decide", text: source.pending }));
          const row = block.text.split("\t");
          if (state.project.kind === "duty" && source.slots.includes(row[0] ?? "") && row.length === 3) {
            writes.push(call(`fixture_write_duty_${index}`, "write_change", { ...origin, kind: "row", target: "duties", data: { slot: row[0], task: row[1], assignee: row[2] } }));
          }
        }
        if (writes.length) return response(writes, "tool_use");
      } else {
        const kind = first.includes("対象の文書: report。") ? "report" : "procedure";
        const pack = getDraftPack(kind, state.project.kind);
        let text: string;
        if (state.project.kind === "board_meeting" && kind === "report") {
          const second = state.project.title.includes("2回目");
          const expected = second ? source.nextDecision : source.decision;
          if (!first.includes(expected)) throw new Error("AIの指示に送った決定がありません");
          text = second ? source.nextMinutes : source.minutes;
        } else if (state.project.kind === "board_meeting") {
          if (!first.includes(source.decision) || !first.includes(source.pending)) throw new Error("前回の決定と未決がAIの資料にありません");
          text = `${source.decision}。\n${source.pending}。`;
        } else if (state.project.kind === "general_meeting") {
          if (!first.includes(source.decision) || !first.includes(source.nextDecision)) throw new Error("一年の決定がAIの資料にありません");
          text = `${source.decision}。\n${source.nextDecision}。`;
        } else if (state.project.kind === "city_request") {
          if (!first.includes("架空の地域担当窓口")) throw new Error("市の通知がAIの資料にありません");
          text = source.cityDraft;
        } else throw new Error("この架空のAIでは扱わない下書きです");
        drafts++;
        return response([call("fixture_write_draft", "write_change", { kind: "draft", target: kind, confidence: "high", data: {
          title: pack.title, scope: pack.scope, text, items: [{ key: "content", content: text }],
          pack_version: pack.version, based_on_state_version: state.project.stateVersion,
        } })], "tool_use");
      }
    }
    return response([{ type: "text", text: "架空のAIの応答を終えました。" }], "end_turn");
  } });
  setClientFactory(() => client);
  setPipelineDeps({ createClient: () => client });
  return { ...seeded, activity: () => ({ calls, drafts, connections }) };
}
