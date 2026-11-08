import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { addQuestion, applyChange, createProject, getProjectState, type ItemKey } from "../src/project/api";
import { answerOriginalReference } from "../src/project/apply";
import type { ReferenceConflictDetail } from "../src/project/questions-original-reference";
import { get, postForm, realApp } from "./helpers";

beforeEach(() => setClientFactory(() => { throw new Error("試験では本物のAIを呼びません"); }));
afterEach(() => setClientFactory(null));

async function setup() {
  const admin = await seedAdmin(env.DB);
  const { ward, account } = admin;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
  const root = `/${ward.slug}/admin/projects/${project.projectId}/questions`;
  const send = async (name: string, day: string) => {
    const received = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin",
      parts: [{ kind: "text", filename: `${name}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(name) }] });
    const ref = received.received[0]!.originalId;
    await env.DB.prepare("UPDATE originals SET document_date = ?, document_date_source = 'office_modified' WHERE ward_id = ? AND original_id = ?")
      .bind(day, ward.wardId, ref).run();
    return ref;
  };
  const a = await send("案内その一", "2025-09-20T10:00:00Z");
  const b = await send("案内その二", "2025-09-12T10:00:00Z");
  const apply = (ref: string, itemKey: ItemKey, value: string, year = 2025, packVersion = "u100@1") =>
    applyChange(env.DB, ward.wardId, project.projectId, { kind: "item", itemKey, value,
      source: { kind: "original", ref, year, locator: `${itemKey}の行` }, confidence: "high", packVersion });
  const state = () => getProjectState(env.DB, ward.wardId, project.projectId);
  const detail = async (questionId: string) => {
    const row = await env.DB.prepare("SELECT detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ?")
      .bind(ward.wardId, project.projectId, questionId).first<{ detail: string }>();
    return JSON.parse(row!.detail) as ReferenceConflictDetail;
  };
  return { ...admin, project, root, a, b, apply, state, detail };
}

it.each(["open", "later"] as const)("同じ二資料の二項目を%sの質問一つにまとめ、資料の選択で参考だけを一緒に直す", async (pendingState) => {
  const s = await setup();
  // 二項目を逆の順で受け取っても、同じ資料の値をそろえて選べる。
  await s.apply(s.a, "content", "豚汁と抽選会");
  await s.apply(s.b, "due", "10月3日まで");
  await s.apply(s.b, "content", "豚汁");
  const first = (await s.state())!.questions[0]!;
  await env.DB.prepare("UPDATE project_questions SET state = ? WHERE ward_id = ? AND project_id = ? AND question_id = ?")
    .bind(pendingState, s.ward.wardId, s.project.projectId, first.questionId).run();
  const added = await s.apply(s.a, "due", "10月5日まで");
  expect(added).toMatchObject({ questionIds: [first.questionId] });
  const before = (await s.state())!;
  expect(before.questions).toHaveLength(1);
  expect(before.questions[0]).toMatchObject({ questionId: first.questionId, state: pendingState });
  const detail = await s.detail(first.questionId);
  expect(detail.items).toHaveLength(2);
  expect(detail.items!.map((item) => item.itemKey)).toEqual(["content", "due"]);
  expect(detail.options).toEqual(detail.originals!.map((original) => original.description));
  expect(detail.options).toHaveLength(2);
  for (const item of detail.items!) {
    const active = await env.DB.prepare("SELECT content, source_ref FROM project_item_values WHERE ward_id = ? AND value_id = ? AND superseded_at IS NULL")
      .bind(s.ward.wardId, item.currentValueId).first();
    expect(active).not.toBeNull();
    expect(item.sources.map((source) => source.ref)).toEqual(detail.originals!.map((original) => original.originalId));
    expect(item.sources.every((source) => source.locator?.includes(`${item.itemKey}の行`))).toBe(true);
  }
  const text = before.questions[0]!.text;
  expect(text).toContain("内容:");
  expect(text).toContain("返事の締切:");
  expect(text.split("どちらが最後の資料ですか。")).toHaveLength(2);
  expect(text.split(detail.comparisonText!)).toHaveLength(2);
  for (const description of detail.options!) expect(text).toContain(description);
  const compare = await (await get(realApp, `${s.root}/${first.questionId}/compare`, s.cookie)).text();
  for (const item of detail.items!) for (const [index, value] of item.options.entries()) {
    expect(compare).toContain(`<dt>${detail.originals![index]!.description}</dt><dd class="preserve-lines">${value}</dd>`);
  }
  expect(compare).toContain("<legend>最後の資料</legend>");
  expect(compare).not.toContain("今年使う内容");
  for (const itemKey of ["content", "due"] as const) await applyChange(env.DB, s.ward.wardId, s.project.projectId, {
    kind: "item", itemKey, value: `今年の${itemKey}`, source: { kind: "person", accountId: s.account.accountId }, confidence: "high", packVersion: "u100-current@1",
  });
  const other = await seedAdmin(env.DB);
  expect(await answerOriginalReference(env.DB, other.ward.wardId, s.project.projectId, first.questionId, other.account.accountId, detail.options![0]!)).toBeNull();
  const chosenRef = pendingState === "open" ? s.a : s.b;
  const answer = detail.options![detail.originals!.findIndex((original) => original.originalId === chosenRef)]!;
  expect((await postForm(realApp, `${s.root}/${first.questionId}`, { answer }, s.cookie)).status).toBe(303);
  const after = (await s.state())!;
  expect(after.questions).toHaveLength(0);
  for (const itemKey of ["content", "due"] as const) {
    const item = after.items.find((item) => item.key === itemKey)!;
    const expected = itemKey === "content" ? chosenRef === s.a ? "豚汁と抽選会" : "豚汁" : chosenRef === s.a ? "10月5日まで" : "10月3日まで";
    expect(item.references).toHaveLength(1);
    expect(item.references[0]).toMatchObject({ content: expected, refYear: 2025, source: { kind: "original", ref: chosenRef } });
    expect(item.current?.content).toBe(`今年の${itemKey}`);
    const attribution = await env.DB.prepare("SELECT created_by_account_id FROM project_item_values WHERE ward_id = ? AND value_id = ?")
      .bind(s.ward.wardId, item.references[0]!.valueId).first();
    expect(attribution).toEqual({ created_by_account_id: s.account.accountId });
  }
  expect(after.tables.decisions).toHaveLength(0);
});

it("古い一項目のdetailも値で答え、今年の内容は変えない", async () => {
  const s = await setup();
  await s.apply(s.a, "due", "10月5日まで");
  const added = await addQuestion(env.DB, s.ward.wardId, s.project.projectId, { kind: "conflict", text: "どちらの締切ですか。", target: "due",
    options: ["10月5日まで", "10月3日まで"], packVersion: "u100-legacy@1" });
  if (added.status !== "added") throw new Error("質問を作れませんでした");
  await env.DB.prepare("UPDATE project_questions SET detail = ? WHERE ward_id = ? AND project_id = ? AND question_id = ?")
    .bind(JSON.stringify({ scope: "reference", refYear: 2025, itemKey: "due", options: ["10月5日まで", "10月3日まで"],
      sources: [s.a, s.b].map((ref) => ({ kind: "original", ref, year: 2025, locator: "締切の行" })) }), s.ward.wardId, s.project.projectId, added.questionId).run();
  expect(await answerOriginalReference(env.DB, s.ward.wardId, s.project.projectId, added.questionId, s.account.accountId, "10月3日まで")).toBe(true);
  const state = (await s.state())!;
  expect(state.items.find((item) => item.key === "due")?.references[0]).toMatchObject({ content: "10月3日まで", source: { ref: s.b } });
  expect(state.items.find((item) => item.key === "due")?.current).toBeNull();
  expect(state.questions).toHaveLength(0);
});

it("今年の二項目は別々に聞き、項目の鍵でない問いだけ説明を短くする", async () => {
  const s = await setup();
  for (const itemKey of ["content", "due"] as const) {
    await s.apply(s.a, itemKey, `${itemKey}その一`, 2026);
    await s.apply(s.b, itemKey, `${itemKey}その二`, 2026);
  }
  const state = (await s.state())!;
  expect(state.questions).toHaveLength(2);
  expect(state.questions.map((question) => question.target).sort()).toEqual(["content", "due"]);
  for (const question of state.questions) {
    expect(question.options).toEqual([`${question.target}その一`, `${question.target}その二`]);
    expect(state.items.find((item) => item.key === question.target)?.current).toBeNull();
    const page = await (await get(realApp, `${s.root}/${question.questionId}/compare`, s.cookie)).text();
    expect(page).toContain("今年使う内容を選んでください。");
  }
  const added = await addQuestion(env.DB, s.ward.wardId, s.project.projectId, { kind: "conflict", text: "去年の当番表はどちらが最後ですか。",
    target: "last-duty-list", options: ["当番表その一", "当番表その二"], packVersion: "u100-ai@1" });
  if (added.status !== "added") throw new Error("質問を作れませんでした");
  const page = await (await get(realApp, `${s.root}/${added.questionId}/compare`, s.cookie)).text();
  expect(page).toContain("当てはまるものを選んでください。");
  expect(page).not.toContain("今年使う内容");
});
