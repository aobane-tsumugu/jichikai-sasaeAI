import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { saveDocument } from "../src/project/actions";
import { addQuestion, applyChange, createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("下書きの（確認中）の欄に、何が決まっていないかとどこで決めるかを書き、年の分からない資料の値は押すと今年の物になる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2030, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "役員会のメモ.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("秋の収穫祭は10月25日（日）") },
  ] });
  const ref = got.received[0]!.originalId;
  // 年の書かれていない資料の値は、年不明の参考に留まる（L-215）
  await applyChange(env.DB, ward.wardId, project.projectId, { kind: "item", itemKey: "date_time", value: "10月25日（日）", confidence: "high", packVersion: "test@1",
    source: { kind: "original", ref, locator: "1行目" } });
  await addQuestion(env.DB, ward.wardId, project.projectId, { kind: "decide", text: "返事の締切はいつですか。", target: "due", packVersion: "test@1" });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "秋の収穫祭を行います。", items: [{ key: "date_time", content: "（確認中）" }, { key: "place", content: "（確認中）" }, { key: "due", content: "（確認中）" }] }) });
  const draft = `${root}/projects/${project.projectId}/draft/announcement`;
  const page = await (await get(realApp, draft, cookie)).text();
  expect(page).toMatch(/まだ決まっていない欄が\d+つあります（「いつ」、「どこで」/);
  expect(page).toContain("年の分からない資料（役員会のメモ.txt）に「10月25日（日）」とあります。今年の資料なら、押すとこの欄に入ります。");
  expect(page).toContain(`formaction="${root}/projects/${project.projectId}/materials/${ref}/this-year"`);
  expect(page).toContain("まだ決まっていません。AIからの質問に答えると、ここに入ります。");
  // 「（確認中）」の「どこで」だけに書き、ただ空いている欄（雨のときなど）には何も書かない
  expect(page.split("まだ決まっていません。分かったら、この欄に書いてください。")).toHaveLength(2);
  expect(page).toContain("まだ決まっていない欄が3つあります（「いつ」、「どこで」、「返事の締切」）。");

  const res = await postForm(realApp, `${root}/projects/${project.projectId}/materials/${ref}/this-year`, { from: "draft:announcement" }, cookie);
  expect(res.headers.get("location")).toBe(`${draft}?notice=this_year`);
  const after = await (await get(realApp, res.headers.get("location")!, cookie)).text();
  expect(after).toContain("年の分からない資料を、今年の資料として入れ直しました。");
  expect(after).toContain('value="10月25日（日）"');
  expect(after).toContain("あとから決まった今年の内容を入れました。保存すると下書きにも残ります。");
});
