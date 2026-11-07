import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { WARD_TABLE_POLICY } from "../src/archive/snapshot";
import { seedAdmin, seedWard } from "../src/core/testing";
import { eventPeriodText, parseEventDay, seasonText } from "../src/core/time";
import { receive } from "../src/intake/receive";
import { taskPeriodText } from "../src/map/next";
import { addDays } from "../src/map/template";
import { answerQuestion, setEventDay, setMapTask } from "../src/project/actions";
import { applyChange, createProject, getProjectState, type MapTaskView } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("一日と二日間と集金期間を持ち、旬の目安と決まった日を分け、資料の終わる日を仕事に反映する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const title = FIRST_SLICE.draftTitle;
  const one = await createProject(env.DB, ward.wardId, {
    kind: "event", title, year: 2026, eventDay: "2026-11-02", accountId: account.accountId,
  });
  const state = async (id: string) => {
    const value = await getProjectState(env.DB, ward.wardId, id);
    if (!value) throw new Error("架空の予定が見つかりません");
    return value;
  };
  const task = (tasks: MapTaskView[], key: string) => {
    const value = tasks.find((entry) => entry.taskKey === key);
    if (!value) throw new Error(`架空の仕事${key}がありません`);
    return value;
  };

  // 試験用D1だけを変更前の表に戻し、実際の0709で既存の行が保たれることを確かめる。
  const legacy = env.TEST_MIGRATIONS.find((migration) => migration.name.includes("0301_"))?.queries
    .find((query) => /CREATE TABLE project_deadlines\s*\(/.test(query));
  const upgrade = env.TEST_MIGRATIONS.find((migration) => migration.name.includes("0709_"));
  if (!legacy || !upgrade) throw new Error("日付の移行が見つかりません");
  const saved = await env.DB.prepare("SELECT * FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'event_day'")
    .bind(ward.wardId, one.projectId).first<{ ward_id: string; project_id: string; kind: string; due_on: string; updated_at: string; updated_by_account_id: string | null }>();
  if (!saved) throw new Error("移行前の実施日がありません");
  await env.DB.batch([env.DB.prepare("DROP TABLE project_deadlines"), env.DB.prepare(legacy)]);
  await env.DB.prepare("INSERT INTO project_deadlines (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(saved.ward_id, saved.project_id, saved.kind, saved.due_on, saved.updated_at, saved.updated_by_account_id).run();
  await env.DB.batch(upgrade.queries.map((query) => env.DB.prepare(query)));
  expect(await env.DB.prepare("SELECT * FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'event_day'")
    .bind(ward.wardId, one.projectId).first()).toEqual(saved);
  expect((await state(one.projectId)).project.deadlines).toMatchObject({ event_day: saved.due_on, event_end: saved.due_on });
  expect(WARD_TABLE_POLICY.find((entry) => entry.table === "project_deadlines")).toMatchObject({ snapshot: true, export: true, deletion: true });

  for (const [day, expected] of [["01", "11月上旬"], ["10", "11月上旬"], ["11", "11月中旬"], ["20", "11月中旬"], ["21", "11月下旬"], ["30", "11月下旬"]]) {
    expect(seasonText(`2026-11-${day}`)).toBe(expected);
  }
  expect(eventPeriodText("2026-11-02")).toBe("11月2日（月）");
  expect(taskPeriodText(task((await state(one.projectId)).mapTasks, "committee"))).toBe("8月中旬から9月上旬");
  expect(taskPeriodText(task((await state(one.projectId)).mapTasks, "day"))).toBe("11月2日（月）");

  const entry = await (await get(realApp, `${root}/projects?title=${encodeURIComponent(`${title}の二日間`)}`, cookie)).text();
  expect(entry).toContain('name="eventEnd" type="date"');
  const started = await postForm(realApp, `${root}/projects`, {
    kind: "event", title: `${title}の二日間`, year: "2026", eventDay: "2026-11-02", eventEnd: "2026-11-03",
  }, cookie);
  expect(started.status).toBe(303);
  const path = started.headers.get("location");
  const id = path?.match(/\/projects\/([^/]+)\/map$/)?.[1];
  if (!path || !id) throw new Error("二日間の予定を始められませんでした");
  let two = await state(id);
  expect(two.project.deadlines).toMatchObject({ event_day: "2026-11-02", event_end: "2026-11-03" });
  expect(task(two.mapTasks, "committee").periodStart).toBe(addDays("2026-11-02", -75));
  expect(task(two.mapTasks, "day")).toMatchObject({ periodStart: "2026-11-02", periodEnd: "2026-11-03" });
  expect(task(two.mapTasks, "report")).toMatchObject({ periodStart: "2026-11-04", periodEnd: "2026-11-17" });
  const html = await (await get(realApp, path, cookie)).text();
  expect(html).toContain("11月2日（月）から3日（火）");
  expect(html).toContain("8月中旬から9月上旬");
  expect(html).toContain("11月上旬から11月中旬");
  await receive(env, { wardId: ward.wardId, projectId: id, via: "admin", parts: [
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("11/2〜11/3") },
  ] });
  const year = await (await get(realApp, `${root}/year`, cookie)).text();
  expect(year).toContain("11月2日（月）から3日（火）。準備は8月中旬からです。資料1件が入っています。");
  expect(year).toContain("opacity:0.25");

  // 進み具合だけの変更は旬のまま。役員が時期を変えた仕事は日で示す。
  const venue = task(two.mapTasks, "venue");
  expect(await setMapTask(env.DB, ward.wardId, id, venue.taskId, {
    name: venue.name, start: venue.periodStart!, end: venue.periodEnd!, progress: "started", seatId: null,
  })).toBe(true);
  expect(taskPeriodText(task((await state(id)).mapTasks, "venue"))).toContain("旬");
  expect(await setMapTask(env.DB, ward.wardId, id, venue.taskId, {
    name: venue.name, start: "2026-10-20", end: "2026-10-21", progress: "started", seatId: null,
  })).toBe(true);
  expect(taskPeriodText(task((await state(id)).mapTasks, "venue"))).toBe("10月20日（火）から21日（水）");
  const done = task(two.mapTasks, "committee");
  expect(await setMapTask(env.DB, ward.wardId, id, done.taskId, {
    name: done.name, start: done.periodStart!, end: done.periodEnd!, progress: "done", seatId: null,
  })).toBe(true);
  const before = await state(id);
  expect((await postForm(realApp, `${path}/event-day`, { event_day: "2026-11-02", event_end: "2026-11-05" }, cookie)).status).toBe(303);
  two = await state(id);
  expect(task(two.mapTasks, "committee").periodStart).toBe(task(before.mapTasks, "committee").periodStart);
  expect(task(two.mapTasks, "venue").periodStart).toBe("2026-10-20");
  expect(task(two.mapTasks, "report").periodStart).toBe("2026-11-06");
  expect(await setEventDay(env.DB, ward.wardId, id, "2026-11-02", account.accountId, "2026-11-03")).toBe(true);
  expect((await state(id)).mapTasks).toEqual(before.mapTasks);
  expect(await setEventDay(env.DB, ward.wardId, id, "2026-11-03", account.accountId, "2026-11-02")).toBe(false);

  const periods = [
    ["11/2〜11/3", "2026-11-02", "2026-11-03"],
    ["10月1日から12月31日まで", "2026-10-01", "2026-12-31"],
    ["2026-11-02〜2026-11-03", "2026-11-02", "2026-11-03"],
    ["2026-12-31から2027-01-02", "2026-12-31", "2027-01-02"],
  ] as const;
  for (const [text, start, end] of periods) {
    expect(parseEventDay(text, 2026)).toBe(start);
    expect(parseEventDay(text, 2026, "end")).toBe(end);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: `${title}（${text}）`, year: 2026, accountId: account.accountId });
    const input = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin",
      parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(`${project.title}\n${text}`) }] });
    const originalId = input.received[0]?.originalId;
    if (!originalId) throw new Error("架空の日程の資料がありません");
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey: "date_time", value: text, source: { kind: "original", ref: originalId, locator: "1行目", year: 2026 },
      confidence: "high", packVersion: "event-period-test@1",
    })).status).toBe("applied");
    const read = await state(project.projectId);
    expect(read.project.deadlines).toMatchObject({ event_day: start, event_end: end });
    expect(task(read.mapTasks, "committee").periodStart).toBe(addDays(start, -75));
    expect(task(read.mapTasks, "report").periodStart).toBe(addDays(end, 1));
    expect(task(read.mapTasks, "day")).toMatchObject({ periodStart: start, periodEnd: end });
    expect(await (await get(realApp, `${root}/projects/${project.projectId}/map`, cookie)).text()).toContain(eventPeriodText(start, end));
    if (start === "2026-10-01") {
      const correction = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
        { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("10月1日から12月30日まで") },
      ] });
      const correctionId = correction.received[0]?.originalId;
      if (!correctionId) throw new Error("架空の変更の資料がありません");
      expect((await applyChange(env.DB, ward.wardId, project.projectId, {
        kind: "item", itemKey: "date_time", value: "10月1日から12月30日まで",
        source: { kind: "original", ref: correctionId, locator: "1行目", year: 2026 }, confidence: "high", packVersion: "event-period-test@1",
      })).status).toBe("conflict");
      const question = (await state(project.projectId)).questions.find((entry) => entry.target === "date_time");
      if (!question) throw new Error("終わる日の食い違いがありません");
      expect(await answerQuestion(env.DB, ward.wardId, project.projectId, question.questionId, "answer", "10月1日から12月30日まで", account.accountId)).toBe(true);
      expect((await state(project.projectId)).project.deadlines.event_end).toBe("2026-12-30");
    }
  }
  expect(parseEventDay("11/2〜11/31", 2026, "end")).toBeNull();
  expect(parseEventDay("11/3〜11/2", 2026, "end")).toBeNull();
  expect(parseEventDay("11/2 10:00〜12:00", 2026, "end")).toBe("2026-11-02");
  expect(parseEventDay("12月31日から1月2日まで", 2026, "end")).toBe("2027-01-02");
  expect(parseEventDay("12/31〜2027/1/2", 2026)).toBe("2026-12-31");
  const other = await seedWard(env.DB);
  expect(await setEventDay(env.DB, other.wardId, id, "2026-11-02", account.accountId, "2026-11-04")).toBe(false);
  expect((await state(one.projectId)).project.deadlines.event_day).toBe(saved.due_on);
});
