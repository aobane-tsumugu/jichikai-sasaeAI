import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectSummary } from "../src/project/api";
import { get, realApp, sendLatest } from "./helpers";

it("L-319: 変更の連絡は送るたびに積み、前の連絡を畳まずに並べる。連絡の下書きには、案内の日時と場所も直す道を示す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2027, accountId: account.accountId, eventDay: "2027-10-25" });
  const version = async () => (await getProjectSummary(env.DB, ward.wardId, project.projectId))!.stateVersion;
  await applyChange(env.DB, ward.wardId, project.projectId, { kind: "item", itemKey: "place", value: "集会所の広場", source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "test@1" });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "秋の収穫祭のご案内", scope: "public", basedOn: await version(),
    body: JSON.stringify({ text: "秋の収穫祭を行います。", items: [{ key: "place", content: "集会所の広場" }] }) });
  expect((await sendLatest(ward.slug, ward.wardId, project.projectId, "announcement", cookie)).status).toBe(303);

  const draft = await (await get(realApp, `${root}/projects/${project.projectId}/draft/notice?edit=1`, cookie)).text();
  expect(draft).toContain("どこでは「集会所の広場」です。");
  expect(draft).toContain(`href="${root}/projects/${project.projectId}/draft/announcement">案内の日時と場所を直す</a>`);

  for (const [title, text] of [["持ち物のお知らせ", "マイバッグを持ってきてください。"], ["場所の変更のお知らせ", "場所を集会所の中に変えます。"]]) {
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "notice", title: title!, scope: "public", basedOn: await version(), body: JSON.stringify({ text, items: [] }) });
    const sent = await sendLatest(ward.slug, ward.wardId, project.projectId, "notice", cookie);
    expect(sent.status).toBe(303);
    expect(await (await get(realApp, sent.headers.get("location")!, cookie)).text()).toContain("案内の日時と場所を直す");
  }
  const page = await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text();
  expect(page).toContain("場所を集会所の中に変えます。");
  expect(page).toContain("マイバッグを持ってきてください。");
  expect(page.indexOf("場所を集会所の中に変えます。")).toBeLessThan(page.indexOf("マイバッグを持ってきてください。"));
  expect(page).not.toContain("変更前の持ち物のお知らせ");
  expect(page).not.toMatch(/<details>[\s\S]*マイバッグを持ってきてください。[\s\S]*<\/details>/);
});
