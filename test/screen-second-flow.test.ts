import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { periodText } from "../src/core/time";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { countWord } from "../src/project/model";
import { get, realApp } from "./helpers";

it("数と時期の言葉を見本の形にする", () => {
  expect(countWord(2)).toBe("2つ");
  expect(countWord(16)).toBe("16件");
  expect(periodText("2026-09-09", "2026-09-24")).toBe("9月9日から24日");
  expect(periodText("2026-09-24", "2026-10-10")).toBe("9月24日から10月10日");
});

it("空の画面は知らせと次にすることだけを出す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const read = async (path: string) => (await (await get(realApp, path, cookie)).text());
  const today = await read(`${root}/projects/today`);
  expect(today).toContain("今やることはありません");
  expect(today).not.toContain("締切のあるもの");
  const inquiries = await read(`${root}/inquiries`);
  expect(inquiries).toContain("受けたことを書く");
  expect(inquiries).not.toContain("届いた問い合わせ（0件）");
  const record = await read(`${root}/archive`);
  expect(record).toContain("<h1>記録</h1>");
  expect(record).toContain("閉じた行事はまだありません");
  expect(record).not.toContain("記録を探す");
  const ward_ = await (await get(realApp, `/${ward.slug}/`)).text();
  expect(ward_).toContain("今、出ているお知らせはありません");
  expect(ward_).not.toContain("これまでのお知らせと報告");
  expect(ward_).not.toContain("自治会の仕事を知る");
});

it("見出しに名前と行き止まりの行事一覧を出さず、区の設定から入り方と問い合わせへ行ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const home = await (await get(realApp, `${root}/`, cookie)).text();
  expect(home).not.toContain(`${account.name} さん`);
  expect(home).not.toContain('<a href="/' + ward.slug + '/admin/">最初の画面</a>');
  expect(await (await get(realApp, `${root}/projects/today`, cookie)).text()).not.toContain("行事一覧");
  const settings = await (await get(realApp, `${root}/settings`, cookie)).text();
  for (const word of ["役員の一覧", "自分の入り方", "区の情報", "決まった知らせの文", "消す希望", "SasaeAIに問い合わせる", "このスマホやパソコンから出る"]) expect(settings).toContain(word);
  expect(settings).toContain("← 最初の画面へ");
});

it("配っていない行事の答えの画面は、開けない案内へ戻さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の配る前の行事", year: 2026, accountId: account.accountId });
  const form = await (await get(realApp, `/${ward.slug}/answer/${project.projectId}`)).text();
  expect(form).toContain(`← ${ward.name}のお知らせへ`);
  expect(form).not.toContain(`/${ward.slug}/p/${project.projectId}"`);
  expect(form).not.toMatch(/<input[^>]*name="district"[^>]*checked/);
  const list = await (await get(realApp, `/${ward.slug}/admin/answers`, cookie)).text();
  expect(list).toContain("架空の配る前の行事（2026年）");
  expect(list).toContain("0世帯が答えています");
});

it("質問の一行は短くし、年を聞く質問は見本の見出しにする", async () => {
  const { questionShort } = await import("../src/project/question-pages");
  const base = { questionId: "q", state: "open", source: null, answer: null, detail: null };
  expect(questionShort({ ...base, kind: "conflict", target: "place", text: "「場所」が食い違っています。今は「架空の広場」です。", options: ["架空の広場", "架空の集会所"] } as never)).toBe("「どこで」が資料によって違います");
  expect(questionShort({ ...base, kind: "unreadable", target: null, text: "協賛先の金額が読めませんでした", options: null } as never)).toBe("協賛先の金額が読めませんでした");
  expect(questionShort({ ...base, kind: "unreadable", target: null, text: "1枚目は、今年のものでしょうか。", options: ["今年のもの", "去年か、それより前のもの"] } as never)).toBe("この資料は今年のものですか");
});
