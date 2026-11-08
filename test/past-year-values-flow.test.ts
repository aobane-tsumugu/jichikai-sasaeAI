import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { checkPublicDraft } from "../src/check";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { applyWardReading } from "../src/know/apply";
import type { Reading } from "../src/ai/schema";
import { getEditableDocument, saveAIDraft } from "../src/project/actions";
import { applyChange, createProject, getProjectState, type ItemKey } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

beforeEach(() => setClientFactory(() => { throw new Error("試験から本物のAIは呼びません"); }));
afterEach(() => { setClientFactory(null); vi.useRealTimers(); });

async function setup() {
  const admin = await seedAdmin(env.DB);
  const { ward, account } = admin;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
  const root = `/${ward.slug}/admin`;
  const send = async (text: string, filename = "資料.txt") => {
    const result = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "text", filename, mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
    const id = result.received[0]?.originalId;
    if (!id) throw new Error("試しの資料を受け取れませんでした");
    return id;
  };
  const apply = (ref: string, itemKey: ItemKey, value: string, year?: number) => applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey, value, source: { kind: "original", ref, locator: "表1/1行目", ...(year === undefined ? {} : { year }) },
    confidence: "high", packVersion: "past-year-test@1",
  });
  const state = async () => {
    const value = await getProjectState(env.DB, ward.wardId, project.projectId);
    if (!value) throw new Error("試しの準備がありません");
    return value;
  };
  return { ...admin, project, root, send, apply, state };
}

it("去年の当番表とお知らせの日は参考に留め、送る前の画面に去年の日付を出す", async () => {
  const s = await setup();
  const old = await s.send("2025年度の当番表。12月26日から28日、申込み12月15日。", "2025年度_当番表.txt");
  const notice = await s.send("2025年度のお知らせ。2025年12月26日から28日。", "2025年度_お知らせ.txt");
  // 繋げる手から今年が渡されても、資料の年度と日付の年を優先する。
  await s.apply(old, "date_time", "12月26日から28日", 2026);
  await s.apply(notice, "due", "2025年12月15日まで", 2026);
  for (const key of ["date_time", "due"]) {
    const item = (await s.state()).items.find((item) => item.key === key);
    expect(item?.current).toBeNull();
    expect(item?.references[0]?.refYear).toBe(2025);
  }
  const undated = await s.send("集合の時間は午後8時です。", "年のない資料.txt");
  await s.apply(undated, "place", "集会所の前");
  expect((await s.state()).items.find((item) => item.key === "place")?.references[0]?.refYear).toBeNull();
  expect((await s.state()).items.find((item) => item.key === "place")?.current).toBeNull();
  await applyChange(env.DB, s.ward.wardId, s.project.projectId, { kind: "item", itemKey: "due", value: "12月20日まで",
    source: { kind: "original", ref: undated, qr: true }, confidence: "high", packVersion: "unknown-qr-test@1" });
  // 今年配った紙（QR で今年の版と分かる物）から読んだ値は、年が書いていなくても今年の中身にする。
  const qrDue = (await s.state()).items.find((item) => item.key === "due");
  expect(qrDue?.current?.content).toBe("12月20日まで");
  const state = await s.state();
  expect(await saveAIDraft(env.DB, s.ward.wardId, s.project.projectId, "announcement", "past-year-draft@1", {
    text: "■いつ行いますか\n2025年12月26日から28日\n■返事をお願いします\n2025年12月15日まで",
    items: [], based_on_state_version: state.project.stateVersion,
  })).toBe(true);
  const draft = await getEditableDocument(env.DB, s.ward.wardId, s.project.projectId, "announcement");
  expect(draft).not.toBeNull();
  const page = await postForm(realApp, `${s.root}/publish/${s.project.projectId}/confirm`, {
    documentId: draft!.documentId, recipientScope: "all_households", allCopies: "1", lineDelivery: "skip",
  }, s.cookie);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("去年の日付のようです");
});

it("画面から去年の食い違いに答えると参考を選び直し、今年の中身と下書きは変えない", async () => {
  const s = await setup();
  const a = await s.send("2025年度の案内。締切10月3日。");
  const b = await s.send("2025年度の案内。締切10月5日。");
  await s.apply(a, "due", "10月3日", 2025);
  await s.apply(b, "due", "10月5日", 2025);
  await applyChange(env.DB, s.ward.wardId, s.project.projectId, { kind: "item", itemKey: "due", value: "2026年11月30日",
    source: { kind: "person", accountId: s.account.accountId }, confidence: "high", packVersion: "current-due-test@1" });
  const state = await s.state();
  const question = state.questions.find((question) => question.target === "due");
  expect(question).toBeDefined();
  await saveAIDraft(env.DB, s.ward.wardId, s.project.projectId, "announcement", "reference-draft@1", {
    text: "返事は2026年11月30日までです。", items: [{ key: "due", content: "2026年11月30日" }], based_on_state_version: state.project.stateVersion,
  });
  const before = await getEditableDocument(env.DB, s.ward.wardId, s.project.projectId, "announcement");
  expect((await postForm(realApp, `${s.root}/projects/${s.project.projectId}/questions/${question!.questionId}`, { answer: "10月5日" }, s.cookie)).status).toBe(303);
  const after = await s.state();
  expect(after.items.find((item) => item.key === "due")?.references[0]?.content).toBe("10月5日");
  expect(after.items.find((item) => item.key === "due")?.current?.content).toBe("2026年11月30日");
  expect(after.questions).toHaveLength(0);
  expect((await getEditableDocument(env.DB, s.ward.wardId, s.project.projectId, "announcement"))?.body).toBe(before?.body);
  expect(after.tables.decisions).toHaveLength(0);
});

it("今年の日を選ぶまで今年の中身は空で、選ぶと基本情報と決めたことと下書きも同じ日になる", async () => {
  const s = await setup();
  const a = await s.send("2026年4月のメモ。秋の収穫祭は10月18日(日)。");
  const b = await s.send("2026年4月のメモ。秋の収穫祭は10月25日(日)。");
  const reading: Reading = { document_kind: "memo", summary: "行事の日", original_years: [{ original_id: a, year: 2026 }],
    text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    ward_facts: [{ original_id: a, topic: "events", text: "秋の収穫祭は10月18日(日)に行う。\n清掃は10月18日(日)に行う。" }],
  };
  await applyWardReading(env.DB, s.ward.wardId, reading);
  for (const [ref, value] of [[a, "10月18日（日）"], [b, "10月25日（日）"]] as const) {
    await s.apply(ref, "date_time", value, 2026);
    await applyChange(env.DB, s.ward.wardId, s.project.projectId, { kind: "row", table: "decisions",
      data: { what: `秋の収穫祭は${value}`, decidedOn: "2026年4月役員会" },
      source: { kind: "original", ref, year: 2026 }, confidence: "high", packVersion: "date-decision-test@1" });
  }
  const pending = await s.state();
  expect(pending.items.find((item) => item.key === "date_time")?.current).toBeNull();
  const question = pending.questions.find((question) => question.target === "date_time");
  expect(question).toBeDefined();
  await saveAIDraft(env.DB, s.ward.wardId, s.project.projectId, "announcement", "current-draft@1", {
    text: "■いつ行いますか\n10月18日（日）", items: [{ key: "date_time", content: "10月18日（日）" }],
    based_on_state_version: pending.project.stateVersion,
  });
  expect((await postForm(realApp, `${s.root}/projects/${s.project.projectId}/questions/${question!.questionId}`, { answer: "10月25日（日）" }, s.cookie)).status).toBe(303);
  const state = await s.state();
  expect(state.items.find((item) => item.key === "date_time")?.current?.content).toBe("10月25日（日）");
  expect(state.project.deadlines.event_day).toBe("2026-10-25");
  expect(state.mapTasks.find((task) => task.taskKey === "day")).toMatchObject({ periodStart: "2026-10-25", periodEnd: "2026-10-25" });
  expect(state.mapTasks.find((task) => task.taskKey === "duty_roster")).toMatchObject({ periodStart: "2026-10-04", periodEnd: "2026-10-18" });
  const know = await env.DB.prepare("SELECT body FROM ward_know_items WHERE ward_id = ? AND item_id = 'events'").bind(s.ward.wardId).first<{ body: string }>();
  expect(know?.body).toContain("秋の収穫祭は10月25日（日）に行う");
  expect(know?.body).toContain("清掃は10月18日(日)に行う");
  expect(state.tables.decisions).toHaveLength(1);
  expect(state.tables.decisions[0]?.data.what).toBe("いつ: 10月25日（日）");
  const draft = await getEditableDocument(env.DB, s.ward.wardId, s.project.projectId, "announcement");
  expect(draft?.body).toContain("10月25日");
  expect(draft?.body).not.toContain("10月18日");
  expect((await postForm(realApp, `${s.root}/close/${s.project.projectId}/finalize`, {}, s.cookie)).status).toBe(303);
  const archive = await (await get(realApp, `${s.root}/archive/${s.project.projectId}`, s.cookie)).text();
  // 準備の期間にも10月18日が含まれる。開催日と決めたことをそれぞれ確かめる。
  expect(archive).toContain("10月25日（日） 〜 10月25日（日）　当日");
  expect(archive).toContain("10月4日（日） 〜 10月18日（日）　当番表と配置を決める");
  const decisions = archive.match(/<section><h2>決めたこと<\/h2>[\s\S]*?<\/section>/)?.[0];
  expect(decisions).toBeDefined();
  expect(decisions).toContain("いつ: 10月25日");
  expect(decisions).not.toContain("10月18日");
});

it("三つ以上の資料の同じ項目の食い違いは、違う値を並べた問い一つになる", async () => {
  const s = await setup();
  for (const [index, value] of ["10月3日", "10月5日", "10月5日", "10月7日"].entries()) {
    const ref = await s.send(`2025年度の資料${index}。返事は${value}まで。`);
    await s.apply(ref, "due", value, 2025);
  }
  const state = await s.state();
  expect(state.questions.filter((question) => question.target === "due")).toHaveLength(1);
  const question = state.questions.find((question) => question.target === "due")!;
  expect(question.options).toEqual(["10月3日", "10月5日", "10月7日"]);
  await postForm(realApp, `${s.root}/projects/${s.project.projectId}/questions/${question.questionId}`, { answer: "10月7日" }, s.cookie);
  expect((await s.state()).items.find((item) => item.key === "due")?.references[0]?.content).toBe("10月7日");
});

it("案内と募集と連絡は前の年と過ぎた当日・締切を知らせ、報告と今日以降の日は対象外", async () => {
  const s = await setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  for (const kind of ["announcement", "recruitment", "notice"] as const) {
    for (const text of ["2025年12月26日に集まってください", "返事は11月7日まで", "集合は令和8年11月7日です", "2026/11/07に行います"]) {
      expect((await checkPublicDraft(env.DB, s.ward.wardId, s.project.projectId, kind, { text })).some((finding) => finding.startsWith("去年の日付のようです"))).toBe(true);
    }
    expect(await checkPublicDraft(env.DB, s.ward.wardId, s.project.projectId, kind, { text: "2026年11月8日と11月9日に集まってください" })).toHaveLength(0);
  }
  expect(await checkPublicDraft(env.DB, s.ward.wardId, s.project.projectId, "report", { text: "2025年12月26日に行いました" })).toHaveLength(0);
});
