// U42のローカル確認専用。本体の経路を使い、Anthropicへの通信だけを架空にする。
import Anthropic from "@anthropic-ai/sdk";
import { meetingMaterial } from "../scripts/walkthrough-meeting";
import { setClientFactory } from "../src/ai/deps";
import { setWorkersRoute } from "../src/ai/session";
import { seedAdmin } from "../src/core/testing";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getDraftPack } from "../src/draft/packs";
import type { Env } from "../src/env";

export async function prepareMeetingRuntime(env: Env) {
  const seeded = await seedAdmin(env.DB);
  await setWorkersRoute(env.DB, seeded.ward.wardId, true);
  const source = meetingMaterial();
  let calls = 0;
  let drafts = 0;
  const client = new Anthropic({ apiKey: "fictional-u42-ai", maxRetries: 0, fetch: async (input, init) => {
    if (!String(input).endsWith("/v1/messages")) throw new Error("架空のMessages以外への通信です");
    calls++;
    const request = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string | { type: string; content?: string; is_error?: boolean; tool_use_id?: string }[] }[];
    };
    const first = request.messages[0]?.content;
    if (typeof first !== "string") throw new Error("架空のAIに指示がありません");
    const ticket = /^札: (.+)$/m.exec(first)?.[1];
    if (!ticket) throw new Error("架空のAIに書き込み先がありません");
    const response = (content: unknown, stopReason: string) => Response.json({
      id: "msg_fictional_u42", type: "message", role: "assistant", model: "fictional-u42",
      content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    });
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "tool_use", id, name, input: { ...args, ticket } });
    if (request.messages.length === 1) return response([
      call("fixture_state", "get_project_state", {}),
      ...(/^仕事: connect$/m.test(first) ? [call("fixture_reading", "get_reading", {})] : []),
    ], "tool_use");
    const last = request.messages.at(-1)?.content;
    if (!Array.isArray(last)) throw new Error("架空のAIへ道具の答えが届いていません");
    for (const result of last) {
      if (result.is_error) throw new Error("架空のAIの道具が失敗しました");
      if (result.tool_use_id === "fixture_draft" && !result.content?.includes('"applied"')) throw new Error("架空の下書きが保存されていません");
    }
    if (request.messages.length === 3 && /^仕事: draft$/m.test(first)) {
      const kind = first.includes("対象の文書: report。") ? "report" : "announcement";
      if (!first.includes(source.agenda.split("\n")[4] ?? "清掃活動")) throw new Error("AIの指示に送った議案がありません");
      if (kind === "report" && !first.includes(source.decision)) throw new Error("AIの指示に送った会議の記録がありません");
      const state = JSON.parse(last.find(r => r.tool_use_id === "fixture_state")?.content ?? "null") as { project: { stateVersion: number } };
      const pack = getDraftPack(kind, "general_meeting");
      drafts++;
      return response([call("fixture_draft", "write_change", { kind: "draft", target: kind, confidence: "high", data: {
        title: pack.title, scope: pack.scope, text: kind === "report" ? source.minutes : source.announcement,
        items: [
          { key: "date_time", content: source.date + "10時" }, { key: "place", content: "架空の集会室" },
          ...(kind === "announcement" ? [{ key: "content", content: "清掃活動の回数、遊具の更新" }, { key: "due", content: source.due }] : []),
        ],
        pack_version: pack.version, based_on_state_version: state.project.stateVersion,
      } })], "tool_use");
    }
    return response([{ type: "text", text: "架空のAIの応答を終えました。" }], "end_turn");
  } });
  setClientFactory(() => client);
  setPipelineDeps({ createClient: () => client });
  return { ...seeded, activity: () => ({ calls, drafts }) };
}
