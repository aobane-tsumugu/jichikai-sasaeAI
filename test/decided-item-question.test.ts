import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveAIDraft } from "../src/project/actions";
import { addQuestion, createProject, getProjectState } from "../src/project/api";
import { questionItemKey } from "../src/project/question-target";
import { get, postForm, realApp } from "./helpers";

it("質問の対象は、鍵でも本文の見出しでも画面の名前でも、項目の鍵にそろえる", () => {
  expect(questionItemKey("date_time")).toBe("date_time");
  expect(questionItemKey("日時")).toBe("date_time");
  expect(questionItemKey("いつ")).toBe("date_time");
  expect(questionItemKey("items.date_time")).toBe("date_time");
  expect(questionItemKey("返事の締切")).toBe("due");
  expect(questionItemKey("duties:受付")).toBeNull();
  expect(questionItemKey("")).toBeNull();
});

it("案内の下書きの「いつ」に日を書いて保存すると、日を聞いていた質問を答えた扱いにし、ほかの項目の質問は残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  await addQuestion(env.DB, ward.wardId, project.projectId, { kind: "decide", target: "日時", text: "今年の年末の見回りは、何月何日の何時から何時までにしますか。", packVersion: "test@1" });
  await addQuestion(env.DB, ward.wardId, project.projectId, { kind: "decide", target: "place", text: "今年はどこに集まりますか。", packVersion: "test@1" });
  expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, "announcement", "test@1", {
    title: "年末の見回りのご案内", text: "■いつ\n日時（確認中）\n\n■どこで\n（確認中）", items: [],
  })).toBe(true);
  const root = `/${ward.slug}/admin/projects/${project.projectId}`;
  const draft = await (await get(realApp, `${root}/draft/announcement`, cookie)).text();
  // 日を聞く質問があることを、欄の下で知らせる。
  expect(draft).toContain(`${root}/questions`);
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect((await postForm(realApp, `${root}/draft/announcement/save`, {
    title: "年末の見回りのご案内", scope: "public", based_on: String(state!.project.stateVersion), text: "■いつ\n日時（確認中）\n\n■どこで\n（確認中）",
    item_date_time: "2026年12月26日（土）から28日（月）まで", item_place: "",
  }, cookie)).status).toBe(303);
  const questions = await env.DB.prepare("SELECT target, state, answer FROM project_questions WHERE ward_id = ? AND project_id = ? ORDER BY target").bind(ward.wardId, project.projectId).all<{ target: string; state: string; answer: string | null }>();
  expect(questions.results).toEqual([
    { target: "place", state: "open", answer: null },
    { target: "日時", state: "answered", answer: "2026年12月26日（土）から28日（月）まで" },
  ]);
  const page = await (await get(realApp, `${root}/questions`, cookie)).text();
  expect(page).toContain("今年はどこに集まりますか。");
  expect(page).not.toContain("何月何日の何時から何時までにしますか");
});
