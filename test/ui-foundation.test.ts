import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { get, postForm, realApp } from "./helpers";

it("入力の誤りから戻って行事を開き、住民も書き直して答えを送れる", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const invalid = await postForm(realApp, `${root}/projects`, { kind: "unknown" }, cookie);
  expect(invalid.status).toBe(303);
  expect(invalid.headers.get("location")).toBe(`${root}/projects?error=choose_kind`);
  const guidance = await (await get(realApp, invalid.headers.get("location")!, cookie)).text();
  expect(guidance).toContain("種類を選んでください");
  expect(guidance).toContain(`${ward.name} 役員の画面`);
  expect(guidance).toContain('>最初の画面</a>');
  expect(guidance).toContain('<body ontouchstart="">');
  expect(guidance).toContain('<p class="lead">行事や総会、市からの依頼を始める画面です。');
  const unknown = "URLに書いた文を表示しない";
  const ignored = await (await get(realApp, `${root}/projects?error=${encodeURIComponent(unknown)}`, cookie)).text();
  expect(ignored).not.toContain(unknown);
  expect(ignored).not.toContain('role="alert"');

  const opened = await postForm(realApp, `${root}/projects`, {
    kind: "event", title: FIRST_SLICE.nextYearTitle,
    year: String(FIRST_SLICE.nextYear), eventDay: FIRST_SLICE.eventDay,
  }, cookie);
  expect(opened.status).toBe(303);
  const mapPath = opened.headers.get("location")!;
  const projectId = mapPath.split("/").at(-2)!;
  const map = await (await get(realApp, mapPath, cookie)).text();
  expect(map).toContain("10月23日（土）");
  const answerPath = `/${ward.slug}/answer/${projectId}`;
  const failed = await postForm(realApp, answerPath, { household: "", district: FIRST_SLICE.district, people_count: "2" });
  expect(failed.status).toBe(400);
  expect(failed.headers.get("content-type")).toContain("text/html");
  const errorPage = await failed.text();
  expect(errorPage).toContain("お名前が入っていません");
  expect(errorPage).toContain(`action="${answerPath}"`);
  expect(errorPage).toContain(`<strong>${ward.name}</strong>`);
  expect(await listAnswers(env.DB, ward.wardId, projectId)).toHaveLength(0);

  expect((await get(realApp, answerPath)).status).toBe(200);
  const sent = await postForm(realApp, answerPath, {
    household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, people_count: "2",
  });
  expect(sent.status).toBe(200);
  expect(await sent.text()).toContain("答えを受け付けました");
  expect(await listAnswers(env.DB, ward.wardId, projectId)).toMatchObject([
    { household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, peopleCount: 2, source: "web" },
  ]);
});
