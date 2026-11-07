import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

const day = (offset: number) => new Date(Date.now() + 9 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

it("トップは、当日が過ぎた準備で当日の前の仕事を今の時期と書かず、報告をまとめて終わりにする道を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const past = await createProject(env.DB, ward.wardId, { kind: "board_meeting", title: "架空の済んだ役員会", year: Number(day(-40).slice(0, 4)), eventDay: day(-40), accountId: account.accountId });
  // 終わりにしていない準備しか無い時は、それを一番上に出し、主なボタンを終わりにする道にする
  const only = await (await get(realApp, `${root}/`, cookie)).text();
  expect(only).toContain("架空の済んだ役員会の報告をまとめて終わりにする</a>");
  expect(only).toContain(`href="${root}/close/${past.projectId}"`);
  expect(only).toContain("に行いました（40日過ぎました）。まだ終わりにしていません。");
  expect(only).not.toContain("今は「議題を集める」の時期です。");

  // 先の準備があれば、そちらの仕事を一番上に出し、過ぎた準備は見ないと進まないことに一文で出す
  await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の先の祭り", year: Number(day(30).slice(0, 4)), eventDay: day(30), accountId: account.accountId });
  const both = await (await get(realApp, `${root}/`, cookie)).text();
  const main = both.slice(both.indexOf('<section class="next">'), both.indexOf("</section>", both.indexOf('<section class="next">')));
  expect(main).toContain("架空の先の祭り");
  expect(main).not.toContain("架空の済んだ役員会");
  expect(both).toContain("役員が見ないと進まないこと");
  expect(both).toContain("架空の済んだ役員会の報告をまとめて終わりにする</a>");
});
