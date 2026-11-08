import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { callTool } from "../src/ai/mcp";
import { newId, nowIso } from "../src/core/ids";
import { seedAdmin } from "../src/core/testing";
import { buildDirectReading } from "../src/intake/direct-reading";
import { sha256Hex } from "../src/intake/media";
import { receive } from "../src/intake/receive";
import { answerQuestion, setEventDay, setMapTask } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { get, realApp } from "./helpers";

it("チラシの日時を段取りと一年とトップにつなぎ、手で入れた日と参考資料を守る", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T03:00:00Z"));
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const root = `/${ward.slug}/admin`;
    const open = (title: string) => createProject(env.DB, ward.wardId, {
      kind: "event", title, year: 2026, accountId: account.accountId,
    });
    const state = async (projectId: string) => {
      const value = await getProjectState(env.DB, ward.wardId, projectId);
      if (!value) throw new Error("試しの行事が見つかりません");
      return value;
    };
    let sequence = 0;
    // 試しの写真と、読む手が返した形の読み取りを用意する。本物のAIは呼ばない。
    const prepare = async (projectId: string, text: string, year: number | null = 2026) => {
      const input = await receive(env, {
        wardId: ward.wardId, projectId, via: "line_direct",
        parts: [{ kind: "photo", filename: `${FIRST_SLICE.draftTitle}.jpg`, mediaType: "image/jpeg",
          bytes: new Uint8Array([...FIRST_SLICE.answerSheetPhotoBytes, ++sequence]) }],
      });
      const originalId = input.received[0]?.originalId;
      if (!input.jobId || !originalId) throw new Error("試しの写真を受け取れませんでした");
      const body = buildDirectReading([{ originalId, text }]);
      body.original_years = [{ original_id: originalId, year }];
      const ticket = `tk_${newId()}`;
      await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
        VALUES (?, ?, ?, 'model', 'event-day-test@1', 'fictional-test', ?, ?)`)
        .bind(newId(), ward.wardId, input.jobId, JSON.stringify(body), nowIso()).run();
      await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND job_id = ?")
        .bind(await sha256Hex(ticket), ward.wardId, input.jobId).run();
      return async () => {
        const result = await callTool(env, ward.wardId, "write_change", {
          ticket, kind: "item", original_id: originalId, locator: "1行目", target: "date_time",
          data: { value: text }, confidence: "high",
        });
        expect(result.isError).toBeUndefined();
        return JSON.parse(result.content[0]!.text) as { status: string; duplicate?: boolean };
      };
    };

    const project = await open("試しのチラシの行事");
    const before = await state(project.projectId);
    const venue = before.mapTasks.find((task) => task.taskKey === "venue");
    if (!venue) throw new Error("会場の仕事がありません");
    expect(await setMapTask(env.DB, ward.wardId, project.projectId, venue.taskId, {
      name: venue.name, start: "2026-09-01", end: "2026-09-02", progress: "done", seatId: null,
    })).toBe(true);
    const write = await prepare(project.projectId, "2026/11/19 THU 10:00〜12:00");
    expect((await write()).status).toBe("applied");
    let saved = await state(project.projectId);
    expect(saved.project.deadlines.event_day).toBe("2026-11-19");
    expect(saved.mapTasks.find((task) => task.taskId === venue.taskId)).toMatchObject({
      progress: "done", periodStart: "2026-09-01", periodEnd: "2026-09-02",
    });
    expect(saved.mapTasks.find((task) => task.taskKey === "duty_roster")).toMatchObject({
      periodStart: "2026-10-29", periodEnd: "2026-11-12",
    });
    expect(saved.mapTasks.find((task) => task.taskKey === "day")).toMatchObject({
      periodStart: "2026-11-19", periodEnd: "2026-11-19",
    });
    for (const task of saved.mapTasks) {
      expect(task.periodStart).not.toBeNull();
      expect(task.periodEnd).not.toBeNull();
    }
    expect(await write()).toMatchObject({ status: "applied", duplicate: true });
    expect((await state(project.projectId)).mapTasks).toEqual(saved.mapTasks);
    for (const path of ["/", "/year", `/projects/${project.projectId}/map`]) {
      const response = await get(realApp, `${root}${path}`, cookie);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(project.title);
      expect(html).toContain("11月19日");
      if (path === "/") expect(html).toContain("「当番表と配置を決める」");
    }

    // 年のない表記は、この行事の年から補う。
    for (const text of ["11月19日（木）", "令和8年11月19日", "11/19"]) {
      const other = await open(`試しの日付の確認${sequence}`);
      expect((await (await prepare(other.projectId, text))()).status).toBe("applied");
      expect((await state(other.projectId)).project.deadlines.event_day).toBe("2026-11-19");
    }

    const manual = await open("試しの手で日を入れた行事");
    expect(await setEventDay(env.DB, ward.wardId, manual.projectId, "2026-11-20", account.accountId)).toBe(true);
    const manualBefore = await state(manual.projectId);
    const different = await prepare(manual.projectId, "11/19");
    expect((await different()).status).toBe("conflict");
    saved = await state(manual.projectId);
    expect(saved.project.deadlines.event_day).toBe("2026-11-20");
    expect(saved.mapTasks).toEqual(manualBefore.mapTasks);
    expect(saved.items.find((item) => item.key === "date_time")?.current).toBeNull();
    const question = saved.questions.find((entry) => entry.kind === "conflict" && entry.target === "date_time");
    expect(question?.options).toEqual(["2026年11月20日（金）", "11/19"]);
    expect(await different()).toMatchObject({ status: "conflict", duplicate: true });
    expect((await state(manual.projectId)).questions).toHaveLength(1);
    if (!question) throw new Error("行事の日の質問がありません");
    expect(await answerQuestion(env.DB, ward.wardId, manual.projectId, question.questionId, "answer", "11/19", account.accountId)).toBe(true);
    saved = await state(manual.projectId);
    expect(saved.project.deadlines.event_day).toBe("2026-11-19");
    expect(saved.mapTasks.find((task) => task.taskKey === "day")?.periodStart).toBe("2026-11-19");

    for (const [text, year] of [["日が決まったら知らせます", 2026], ["2026/02/30", 2026], ["11/31", 2026], ["2025/11/19", 2025], ["11/19", null]] as const) {
      const ignored = await open(`試しの日を入れない確認${sequence}`);
      expect((await (await prepare(ignored.projectId, text, year))()).status).toBe("applied");
      const result = await state(ignored.projectId);
      expect(result.project.deadlines.event_day).toBeUndefined();
      for (const task of result.mapTasks) {
        expect(task.periodStart).toBeNull();
        expect(task.periodEnd).toBeNull();
      }
    }
  } finally {
    vi.useRealTimers();
  }
});
