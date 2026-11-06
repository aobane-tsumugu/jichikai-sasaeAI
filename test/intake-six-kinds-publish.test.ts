import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin } from "../src/core/testing";
import { pendingMaterialGroups } from "../src/intake/groups";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getProjectState } from "../src/project/api";
import type { DocumentKind, ProjectKind, Scope } from "../src/project/model";
import { documentTitle } from "../src/project/heading";
import { get, postForm, realApp } from "./helpers";

// 資料の題と本文はすべてこの試験のための架空のもの。
const cases: { kind: ProjectKind; title: string; first: DocumentKind; scope: Scope; distributed: DocumentKind; task: string; public: boolean }[] = [
  { kind: "event", title: "収穫祭（架空）", first: "announcement", scope: "public", distributed: "announcement", task: "announcement", public: true },
  { kind: "general_meeting", title: "定期総会（架空）", first: "procedure", scope: "staff", distributed: "announcement", task: "notice", public: true },
  { kind: "board_meeting", title: "役員会（架空）", first: "procedure", scope: "staff", distributed: "report", task: "minutes", public: false },
  { kind: "duty", title: "集積所の清掃（架空）", first: "duty_roster", scope: "space", distributed: "notice", task: "notify", public: false },
  { kind: "city_request", title: "設備の状況の依頼（架空）", first: "procedure", scope: "staff", distributed: "report", task: "submit", public: false },
  { kind: "request", title: "街灯の修理の要望（架空）", first: "procedure", scope: "staff", distributed: "report", task: "submit", public: false },
];

// 六種類の受付から複数の配布までを実際のD1・R2で順に通すため、この試験だけ30秒待つ。
it("六つの種類の架空資料から適切な下書きに進み、出欠が要る案内だけに入口を出し、配った仕事を済みにする", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const ctx = createExecutionContext();
  // 外部モデルの通信だけを代える。フォーム、読み取り、R2、D1、配る操作は本体を使う。
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = JSON.parse(request.messages[0]!.content) as { originals: { original_id: string; filename: string }[] };
    return Response.json({ id: "fixture-six-kinds", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ project_suggestions: content.originals.map((original) => {
        const fixture = cases.find((entry) => original.filename === `${entry.kind}.txt`);
        if (!fixture) throw new Error("種類の架空資料がありません");
        return { original_id: original.original_id, kind: fixture.kind, title: fixture.title, date_text: "", place: "" };
      }) }) }], usage: { input_tokens: 100, output_tokens: 100 } });
  } });
  setPipelineDeps({ createClient: () => client });
  setClientFactory(() => { throw new Error("試験から実際のAIへは接続しません"); });
  try {
    const form = new FormData();
    form.set("project_id", "");
    for (const entry of cases) form.append("part", new File([`${entry.title}\nすべて架空の資料です。`], `${entry.kind}.txt`, { type: "text/plain" }));
    const received = await realApp.fetch(new Request(`http://localhost${root}/intake`, {
      method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form,
    }), env, ctx);
    expect(received.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const groups = await pendingMaterialGroups(env.DB, ward.wardId);
    expect(groups).toHaveLength(6);
    expect(await pendingMaterialGroups(env.DB, other.ward.wardId)).toHaveLength(0);

    for (const entry of cases) {
      const group = groups.find((value) => value.kind === entry.kind);
      if (!group) throw new Error(`${entry.kind}の資料がまとまっていません`);
      const startContext = createExecutionContext();
      const started = await realApp.fetch(new Request(`http://localhost${root}/intake/start`, {
        method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ group: group.key, eventDay: "" }),
      }), env, startContext);
      await waitOnExecutionContext(startContext);
      expect(started.status).toBe(303);
      const resultPath = started.headers.get("location");
      if (!resultPath) throw new Error("始めたあとの画面がありません");
      const id = resultPath.split("/").at(-1)!;
      const state = await getProjectState(env.DB, ward.wardId, id);
      if (!state) throw new Error("始めた仕事がありません");
      expect(state.project.kind).toBe(entry.kind);
      const title = documentTitle(entry.kind, entry.first);
      const result = await (await get(realApp, resultPath, cookie)).text();
      expect(result).toContain(`${title}の下書きを見る`);
      expect(result).toContain(`${root}/projects/${id}/draft/${entry.first}`);
      const instruction = await env.DB.prepare("SELECT instruction FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'")
        .bind(ward.wardId, id).first<{ instruction: string }>();
      expect(instruction?.instruction).toContain(`対象の文書: ${entry.first}。範囲: ${entry.scope}`);
      if (entry.kind !== "event") expect(instruction?.instruction).toContain(title);
      const draft = await get(realApp, `${root}/projects/${id}/draft/${entry.first}`, cookie);
      expect(draft.status).toBe(200);
      expect(await draft.text()).toContain(title);
      expect(await getProjectState(env.DB, other.ward.wardId, id)).toBeNull();

      // AIが止まっていても、実際の保存フォームから書いて配れる。
      const distribute = async (kind: DocumentKind, scope: "public" | "space") => {
        const before = await getProjectState(env.DB, ward.wardId, id);
        if (!before) throw new Error("配る仕事がありません");
        const saved = await postForm(realApp, `${root}/projects/${id}/draft/${kind}/save`, {
          title: documentTitle(entry.kind, kind), scope, based_on: String(before.project.stateVersion),
          text: "すべて架空の文書です。設備を確認します。", item_content: "設備を確認します。", item_due: "2099年12月31日",
        }, cookie);
        expect(saved.status).toBe(303);
        expect(saved.headers.get("location")).toContain("notice=saved");
        const version = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d
          JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
          WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
          .bind(ward.wardId, id, kind).first<{ document_id: string; version_id: string; version_no: number }>();
        if (!version) throw new Error("配る下書きがありません");
        const fields = { documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip" };
        const confirmation = await postForm(realApp, `${root}/publish/${id}/confirm`, fields, cookie);
        expect(confirmation.status).toBe(200);
        const preview = await confirmation.text();
        const attends = scope === "public" && kind === "announcement" && (entry.kind === "event" || entry.kind === "general_meeting");
        expect(preview.includes('class="answer-slip-preview"')).toBe(attends);
        expect(preview.includes("この下に「出欠を答える」のボタンが出ます")).toBe(attends);
        const sent = await postForm(realApp, `${root}/publish/${id}/${scope === "public" ? "send" : "space"}`, fields, cookie);
        expect(sent.status).toBe(303);
        const done = sent.headers.get("location");
        if (!done) throw new Error("配ったあとの画面がありません");
        return { ...version, done };
      };

      const distributed = await distribute(entry.distributed, entry.public ? "public" : "space");
      const after = await getProjectState(env.DB, ward.wardId, id);
      if (!after) throw new Error("配ったあとの仕事がありません");
      const completed = after.mapTasks.find((task) => task.taskKey === entry.task);
      expect(completed?.progress).toBe("done");
      expect(after.mapTasks.filter((task) => task.progress === "done").map((task) => task.taskKey)).toEqual([entry.task]);
      const donePage = await (await get(realApp, distributed.done, cookie)).text();
      expect(donePage).toContain(`段取りの「${completed?.name}」を済みにしました。`);
      const map = await (await get(realApp, `${root}/projects/${id}/map?changed=${completed?.taskId}`, cookie)).text();
      expect(map).toContain("いま済みにしました");

      // ほかの種類でも役員が案内を公開できるが、出欠の入口は付かない。
      if (!entry.public) await distribute("announcement", "public");
      const page = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
      expect(page.includes(`/${ward.slug}/answer/${id}`)).toBe(entry.public);
      expect(page.includes("紙の回答票を班長に渡しても答えられます")).toBe(entry.public);
      if (!entry.public) {
        const deadline = await env.DB.prepare("SELECT due_on FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'answer_due'")
          .bind(ward.wardId, id).first<{ due_on: string }>();
        expect(deadline).toBeNull();
      }
    }
  } finally {
    await waitOnExecutionContext(ctx);
    setPipelineDeps(null);
    setClientFactory(null);
  }
}, 30_000);
