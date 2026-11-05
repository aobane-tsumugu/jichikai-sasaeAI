import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { callTool } from "../src/ai/mcp";
import { seedAdmin } from "../src/core/testing";
import { sha256Hex } from "../src/intake/media";
import { receive } from "../src/intake/receive";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

async function setup() {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const input = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: FIRST_SLICE.dutyTitle, mediaType: "text/plain",
      bytes: new TextEncoder().encode(FIRST_SLICE.rainAnnouncement) }],
  });
  const originalId = input.received[0]?.originalId;
  if (!input.jobId || !originalId) throw new Error("架空の資料を受け取れませんでした");
  const ticket = `tk_${crypto.randomUUID()}`;
  await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND job_id = ?")
    .bind(await sha256Hex(ticket), ward.wardId, input.jobId).run();
  const write = async (args: Record<string, unknown>) => {
    const result = await callTool(env, ward.wardId, "write_change", {
      ticket, original_id: originalId, locator: FIRST_SLICE.previousLocator, confidence: "high", ...args,
    });
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0]?.text ?? "null") as { status: string; duplicate?: boolean };
  };
  const state = async () => {
    const value = await getProjectState(env.DB, ward.wardId, project.projectId);
    if (!value) throw new Error("架空のプロジェクトがありません");
    return value;
  };
  return { ward, account, cookie, project, originalId, ticket, write, state, root: `/${ward.slug}/admin/projects/${project.projectId}` };
}

it("年不明は参考に留まり、印のある食い違いだけを問い、選ぶと人の入力として今年に入る", async () => {
  const { ward, account, project, cookie, root, originalId, ticket, write, state } = await setup();
  for (const itemKey of ["place", "content", "rain_plan"] as const) {
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey, value: FIRST_SLICE.previousPlace, source: { kind: "person", accountId: account.accountId },
      confidence: "high", packVersion: "person-test@1",
    });
  }
  // 年は本文にも名前にも無い。読み取りと名前を、繋げる手が両方受け取れる。
  const reading = await callTool(env, ward.wardId, "get_reading", { ticket });
  const body = JSON.parse(reading.content[0]?.text ?? "null") as {
    originals: Array<{ original_id: string; filename: string }>;
    readings: Array<{ body: { document_year: number | null } }>;
  };
  expect(body.originals).toContainEqual({ original_id: originalId, filename: FIRST_SLICE.dutyTitle });
  expect(body.readings[0]?.body.document_year).toBeNull();
  // source_year で year を迂回しても今年には入らない。
  expect((await write({ kind: "item", target: "rain_plan", data: { value: FIRST_SLICE.rainAnnouncement, source_year: FIRST_SLICE.eventYear }, confidence: "low" })).status).toBe("applied");
  expect((await state()).questions).toHaveLength(0);
  for (const target of ["place", "content", "due"] as const) {
    expect((await write({ kind: "item", target, data: { value: FIRST_SLICE.rainAnnouncement }, maybe_this_year: true })).status).toBe("applied");
  }
  let current = await state();
  expect(current.questions).toHaveLength(2); // 締切は今年が空なので問わない。
  expect(current.items.find((item) => item.key === "place")?.current?.content).toBe(FIRST_SLICE.previousPlace);
  expect(current.items.find((item) => item.key === "place")?.references[0]).toMatchObject({
    content: FIRST_SLICE.rainAnnouncement, refYear: null, source: { kind: "original", ref: originalId, year: null },
  });
  const question = current.questions.find((q) => q.target === "place");
  if (!question) throw new Error("場所の問いがありません");
  expect(question.text).toBe(`「場所」が食い違っています。今は「${FIRST_SLICE.previousPlace}」です。年の書いていない資料には「${FIRST_SLICE.rainAnnouncement}」とあります。どちらにしますか。`);
  expect(question.options).toEqual([FIRST_SLICE.previousPlace, FIRST_SLICE.rainAnnouncement]);
  expect((await write({ kind: "item", target: "place", data: { value: FIRST_SLICE.rainAnnouncement }, maybe_this_year: true })).duplicate).toBe(true);
  expect((await state()).questions).toHaveLength(2);
  expect((await postForm(realApp, `${root}/questions/${question.questionId}`, { answer: FIRST_SLICE.rainAnnouncement }, cookie)).status).toBe(303);
  current = await state();
  expect(current.items.find((item) => item.key === "place")?.current).toMatchObject({
    content: FIRST_SLICE.rainAnnouncement, source: { kind: "person" },
  });
  expect(current.items.find((item) => item.key === "due")?.current).toBeNull();
  expect(current.items.find((item) => item.key === "rain_plan")?.current?.content).toBe(FIRST_SLICE.previousPlace);
});

it("この資料は今年の物で項目と表を入れ直し、違う中身は上書きせず問いにする", async () => {
  const { ward, account, project, cookie, root, originalId, write, state } = await setup();
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "place", value: FIRST_SLICE.previousPlace, source: { kind: "person", accountId: account.accountId },
    confidence: "high", packVersion: "person-test@1",
  });
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "row", table: "sponsors", data: { name: FIRST_SLICE.sponsorName, amount: FIRST_SLICE.sponsorAmount },
    source: { kind: "original", ref: originalId, locator: FIRST_SLICE.previousLocator, year: FIRST_SLICE.eventYear },
    confidence: "high", packVersion: "current-test@1",
  });
  expect(await (await get(realApp, root, cookie)).text()).not.toContain("この資料は今年の物</button>");
  for (const target of ["place", "content"] as const) {
    await write({ kind: "item", target, data: { value: FIRST_SLICE.rainAnnouncement } });
  }
  await write({ kind: "row", target: "sponsors", data: { name: FIRST_SLICE.sponsorName, amount: FIRST_SLICE.sponsorAmount + 1 }, maybe_this_year: true });
  await write({ kind: "row", target: "layout", data: { spot: FIRST_SLICE.layoutSpot, position: FIRST_SLICE.layoutPosition } });
  let current = await state();
  expect(current.questions).toHaveLength(0);
  expect(current.tables.sponsors.filter((row) => row.scope === "reference")).toHaveLength(1);
  const page = await (await get(realApp, root, cookie)).text();
  const action = `${root}/materials/${originalId}/this-year`;
  expect(page).toContain(`action="${action}"`);
  expect(page).toContain("この資料は今年の物</button>");
  expect(page).toContain("今年の中身と違う所は、上書きせず問いに並びます。");
  expect((await postForm(realApp, action, {}, cookie)).status).toBe(303);
  current = await state();
  expect(current.items.find((item) => item.key === "content")?.current).toMatchObject({
    content: FIRST_SLICE.rainAnnouncement, source: { kind: "original", ref: originalId, year: FIRST_SLICE.eventYear },
  });
  expect(current.items.find((item) => item.key === "place")?.current?.content).toBe(FIRST_SLICE.previousPlace);
  expect(current.tables.layout).toHaveLength(1);
  expect(current.tables.layout[0]).toMatchObject({ scope: "current", source: { year: FIRST_SLICE.eventYear } });
  expect(current.tables.sponsors).toHaveLength(1);
  expect(current.tables.sponsors[0]?.data.amount).toBe(FIRST_SLICE.sponsorAmount);
  expect(current.questions).toHaveLength(2);
  expect(current.questions.find((q) => q.target === "place")?.options).toEqual([FIRST_SLICE.previousPlace, FIRST_SLICE.rainAnnouncement]);
  expect(await (await get(realApp, root, cookie)).text()).not.toContain("この資料は今年の物</button>");
  // 二度押しで問いを増やさず、別の区や別のプロジェクトからは年を直せない。
  expect((await postForm(realApp, action, {}, cookie)).status).toBe(303);
  expect((await state()).questions).toHaveLength(2);
  const other = await seedAdmin(env.DB);
  const denied = await postForm(realApp, `/${other.ward.slug}/admin/projects/${project.projectId}/materials/${originalId}/this-year`, {}, other.cookie);
  expect(denied.headers.get("location")).toContain("?error=");
  expect((await state()).questions).toHaveLength(2);
});
