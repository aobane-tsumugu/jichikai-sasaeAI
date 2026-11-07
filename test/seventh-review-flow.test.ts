import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { PACK_SYSTEM, PACK_VERSION } from "../src/ai/pack";
import { formatJstDate } from "../src/core/time";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack, listDraftPacks } from "../src/draft/packs";
import { createProject, getProjectState } from "../src/project/api";
import { PROJECT_KINDS } from "../src/project/model";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("初年度の空欄を仕事にせず、入口を相手に渡し、途中で閉じる画面を見ても最後のやることと手直しを記録に残す", async () => {
  // データはすべてfixturesの架空の行事から取る。実際のHonoの入口とD1で通し、外部のAIは呼ばない。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear,
    eventDay: FIRST_SLICE.eventDay, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const close = `${root}/close/${project.projectId}`;
  const map = `${root}/projects/${project.projectId}/map`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };
  const today = await read(`${root}/projects/today`);
  expect(today).not.toContain("まだ入っていないもの");
  expect(today).not.toContain("持ち物");
  expect(today).not.toContain("手伝いの時間帯");
  expect(today).toContain("当日");

  expect(PACK_VERSION).toBe("connect@17");
  expect(PACK_SYSTEM).not.toContain("本文や項目を空欄にして");
  expect(PACK_SYSTEM).toContain("文書の下書きと報告はkind=draft");
  for (const kind of PROJECT_KINDS) {
    for (const pack of listDraftPacks(kind)) {
      expect(pack.instruction).not.toContain("$1");
      if (!(pack.kind === "report" && ["general_meeting", "board_meeting"].includes(kind))) {
        expect(pack.instruction).toContain("分からない任意の項目は、本文の見出しもitemsも省き");
        expect(pack.instruction).toContain("締切がないことだけを質問にしません");
      }
      if (pack.kind === "duty_roster") expect(pack.instruction).not.toContain("本文とitemsの両方に入れてください");
    }
  }
  expect(getDraftPack("duty_roster").instruction).toContain("当番の割り当てはdutiesにだけ入れ");

  const space = `${root}/space/${project.projectId}`;
  expect((await postForm(realApp, `${space}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const invitation = await postForm(realApp, `${space}/invite`, { role: "member" }, cookie);
  expect(invitation.status).toBe(200);
  const invitationHtml = await invitation.text();
  const field = invitationHtml.match(/<input\b[^>]*id="invite-url"[^>]*>/)?.[0];
  const url = field?.match(/value="([^"]+)"/)?.[1];
  if (!field || !url) throw new Error("相手に渡すアドレスの欄がありません");
  expect(field).toContain("readonly");
  expect(field).toContain('onclick="this.select()"');
  expect(invitationHtml).not.toContain(`href="${url}"`);
  const unused = await env.DB.prepare("SELECT used_at FROM project_space_invites WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ used_at: string | null }>();
  expect(unused).toEqual({ used_at: null });
  const entered = await get(realApp, url);
  expect(entered.status).toBe(303);
  expect(cookieFrom(entered, `space_${project.projectId}`)).not.toBeNull();
  expect((await get(realApp, url)).status).toBe(403);

  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  const live = state?.mapTasks.find((task) => task.taskKey === "venue");
  const edited = state?.mapTasks.find((task) => task.taskKey === "day");
  const removed = state?.mapTasks.find((task) => task.taskKey !== "venue" && task.taskKey !== "day");
  if (!live || !edited || !removed) throw new Error("架空のやることが足りません");
  await read(close);
  expect((await postForm(realApp, `${close}/map/${edited.taskId}`, {
    name: FIRST_SLICE.nextYearTask, period: FIRST_SLICE.nextYearPeriod, progress: "done",
    requestedBy: FIRST_SLICE.requestedBy, difficulty: FIRST_SLICE.nextYearDifficulty, nextYear: FIRST_SLICE.nextYearChange,
  }, cookie)).status).toBe(303);
  const shown = await read(close);
  expect(shown).toContain(FIRST_SLICE.nextYearTask);

  // 閉じる画面の表示後に、段取りで仕事を直す・足す・外す。古い画面から閉じても、その時点の仕事を残す。
  expect((await postForm(realApp, `${map}/${live.taskId}`, {
    name: FIRST_SLICE.previousPlace, start: FIRST_SLICE.eventDay, end: FIRST_SLICE.eventDay,
    progress: "done", seat_id: "",
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${map}/add`, { name: FIRST_SLICE.layoutPosition }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${map}/${removed.taskId}/remove`, {}, cookie)).status).toBe(303);
  const form = new URLSearchParams();
  for (const match of shown.matchAll(/name="taskId" value="([^"]+)"/g)) {
    form.append("taskId", match[1]!);
    form.append("requestedBy", FIRST_SLICE.requestedBy);
    form.append("difficulty", FIRST_SLICE.nextYearDifficulty);
    form.append("nextYear", FIRST_SLICE.nextYearChange);
    // 画面に埋めた古い値は、閉じるときの実績として使わない。
    form.append("name", FIRST_SLICE.draftTitle);
    form.append("period", FIRST_SLICE.nextYearPeriod);
    form.append("progress", "open");
  }
  expect(form.getAll("taskId").length).toBeGreaterThan(0);
  const finalized = await realApp.request(`${close}/finalize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", cookie },
    body: form.toString(),
  }, env);
  expect(finalized.status).toBe(303);
  const rows = await env.DB.prepare("SELECT task_id, name, period, progress, requested_by, next_year FROM project_close_map WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).all<{ task_id: string; name: string; period: string; progress: string; requested_by: string; next_year: string }>();
  expect(rows.results.find((task) => task.task_id === live.taskId)).toMatchObject({
    name: FIRST_SLICE.previousPlace, period: `${formatJstDate(FIRST_SLICE.eventDay)} 〜 ${formatJstDate(FIRST_SLICE.eventDay)}`, progress: "done",
    requested_by: FIRST_SLICE.requestedBy, next_year: FIRST_SLICE.nextYearChange,
  });
  expect(rows.results.find((task) => task.task_id === edited.taskId)).toMatchObject({ name: FIRST_SLICE.nextYearTask, period: FIRST_SLICE.nextYearPeriod, progress: "done" });
  expect(rows.results.some((task) => task.task_id === removed.taskId)).toBe(false);
  expect(rows.results.some((task) => task.name === FIRST_SLICE.layoutPosition)).toBe(true);
  const archive = await read(`${root}/archive/${project.projectId}`);
  expect(archive).toContain(FIRST_SLICE.previousPlace);
  expect(archive).toContain(FIRST_SLICE.layoutPosition);
  expect(archive).toContain(FIRST_SLICE.nextYearTask);
  expect(archive).not.toContain(`<h3>${removed.name}</h3>`);
  const seeded = await postForm(realApp, `${root}/archive/${project.projectId}/seed`, {
    title: FIRST_SLICE.nextYearTitle, year: String(FIRST_SLICE.nextYear), eventDay: FIRST_SLICE.eventDay,
  }, cookie);
  expect(seeded.status).toBe(303);
  const nextId = new URL(seeded.headers.get("location") ?? "", "http://localhost").searchParams.get("started");
  if (!nextId) throw new Error("記録から新しく始められませんでした");
  const next = await getProjectState(env.DB, ward.wardId, nextId);
  expect(next?.mapTasks.some((task) => task.name === FIRST_SLICE.nextYearTask)).toBe(true);
  expect(next?.mapTasks.some((task) => task.name === FIRST_SLICE.previousPlace)).toBe(true);
  expect(next?.mapTasks.some((task) => task.name === FIRST_SLICE.layoutPosition)).toBe(true);
  expect(next?.mapTasks.some((task) => task.name === removed.name)).toBe(false);
});
