import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectSummary } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("L-311: 住民へのメッセージを、トップから選ぶ二つと下書きの一つのボタンで住民に送る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの秋の収穫祭", year: 2026, eventDay: "2026-11-23", accountId: account.accountId });
  await createProject(env.DB, ward.wardId, { kind: "board_meeting", title: "試しの年末の役員会", year: 2026, accountId: account.accountId });

  // トップとやることに入口が一つずつある
  expect(await (await get(realApp, `${root}/`, cookie)).text()).toContain(`href="${root}/messages/new">住民へのメッセージを作る</a>`);
  expect(await (await get(realApp, `${root}/projects/${project.projectId}/map`, cookie)).text()).toContain(`href="${root}/messages/new?project=${project.projectId}"`);

  // 選ぶのは、何を伝えるかと、どの準備かの二つ。選ぶ物ごとに、何のための物かを添える。住民に出せない準備は並べない
  const picker = await (await get(realApp, `${root}/messages/new`, cookie)).text();
  expect(picker).toContain("何を伝えますか");
  expect(picker).toContain("行事の案内や宣伝");
  expect(picker).toContain("当日の手伝いなど、一回だけ関われる仕事を募ります。");
  expect(picker).toContain("どの準備のことですか");
  expect(picker).toContain("試しの秋の収穫祭");
  expect(picker).not.toContain("試しの年末の役員会");
  expect(picker).toContain("まだ住民には送りません。");
  const fixed = await (await get(realApp, `${root}/messages/new?project=${project.projectId}`, cookie)).text();
  expect(fixed).not.toContain("どの準備のことですか");
  expect(fixed).toContain(`name="projectId" value="${project.projectId}"`);

  // 行事の連絡事項でも、雨の変更の画面ではなく、いつもの下書きが開く
  const made = await postForm(realApp, `${root}/messages`, { kind: "notice", projectId: project.projectId }, cookie);
  expect(made.status).toBe(303);
  const draftPath = made.headers.get("location") ?? "";
  expect(draftPath).toContain(`${root}/projects/${project.projectId}/draft/notice?edit=1`);
  const draft = await (await get(realApp, draftPath, cookie)).text();
  expect(draft).toContain('name="after" value="send">住民に送る</button>');
  expect(draft).toContain("画像を付ける");
  expect(draft).toContain("LINEの友だちにも送る");
  expect(draft).not.toContain("雨の変更を知らせる</h1>");

  // 「住民に送る」で、保存して、そのまま住民向けのページに載せる
  const stateVersion = (await getProjectSummary(env.DB, ward.wardId, project.projectId))!.stateVersion;
  const sent = await postForm(realApp, `${root}/projects/${project.projectId}/draft/notice/save`, {
    title: "試しの収穫祭の持ち物のお知らせ", text: "当日は、試しの収穫祭の会場に、マイバッグを持ってきてください。", scope: "public",
    based_on: String(stateVersion), after: "send", lineDelivery: "skip", flyer_choice: "none",
  }, cookie);
  expect(sent.status).toBe(303);
  expect(sent.headers.get("location")).toContain(`${root}/publish/${project.projectId}`);
  const record = await env.DB.prepare(`SELECT r.line_status FROM publication_records r JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    WHERE r.ward_id = ? AND r.project_id = ? AND d.kind = 'notice'`).bind(ward.wardId, project.projectId).first<{ line_status: string }>();
  expect(record).not.toBeNull();
  expect(await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text()).toContain("マイバッグを持ってきてください");

  // まだ送っていない下書きは、どの準備の下書きかを名前で並べる
  const saveVersion = (await getProjectSummary(env.DB, ward.wardId, project.projectId))!.stateVersion;
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/draft/recruitment/save`, { title: "試しの手伝いの募集", text: "試しの手伝いを募ります。", scope: "public", based_on: String(saveVersion), flyer_choice: "none" }, cookie)).status).toBe(303);
  expect(await (await get(realApp, `${root}/messages/new`, cookie)).text()).toContain("試しの秋の収穫祭の下書き「試しの手伝いの募集」");

  // 住民向けにならない組み合わせは、理由を書いて選び直してもらう
  const duty = await createProject(env.DB, ward.wardId, { kind: "duty", title: "試しのごみ当番", year: 2026, accountId: account.accountId });
  const refused = await postForm(realApp, `${root}/messages`, { kind: "notice", projectId: duty.projectId }, cookie);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("住民ではなく役員や当番の担当に向けたものなので、ここでは作れません。");
});

it("L-312: 準備を始める時に種類を聞かず、一年の予定ごとの型か、短い一般の型を置く", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const page = await (await get(realApp, `${root}/projects`, cookie)).text();
  expect(page).not.toContain("何の準備ですか");
  expect(page).toContain('name="title"');
  const fromYear = await (await get(realApp, `${root}/projects?title=${encodeURIComponent("春の清掃")}`, cookie)).text();
  expect(fromYear).not.toContain("何の準備ですか");
  expect(fromYear).not.toContain('name="kind"');
  expect(fromYear).toContain("よくある自治会の春の清掃のやることを置きます。あとで足したり外したりできます。");
  expect(fromYear).toContain("今年の春の清掃を始める</button>");
  // 去年もやった予定は、去年の当日と、去年のやることを置き直すことを書く
  const last = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの秋の収穫祭", year: 2025, eventDay: "2025-10-19" });
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind("2025-11-01T00:00:00.000Z", ward.wardId, last.projectId).run();
  const again = await (await get(realApp, `${root}/projects?title=${encodeURIComponent("試しの秋の収穫祭")}`, cookie)).text();
  expect(again).toContain("去年は10月19日に行いました。去年のやることを、今年の日に合わせて置き直します。");
  expect(again).toContain("今年の試しの秋の収穫祭を始める</button>");

  const start = async (title: string) => {
    const response = await postForm(realApp, `${root}/projects`, { title, year: "2026" }, cookie);
    expect(response.status).toBe(303);
    const id = (response.headers.get("location") ?? "").match(/projects\/([^/]+)\/map/)?.[1] ?? "";
    const tasks = await env.DB.prepare("SELECT task_key FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY sort_order")
      .bind(ward.wardId, id).all<{ task_key: string }>();
    const row = await env.DB.prepare("SELECT kind FROM projects WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, id).first<{ kind: string }>();
    return { kind: row?.kind, tasks: tasks.results.map((task) => task.task_key) };
  };
  // 表に無い物は、名前の言葉から種類を当てず、短い一般の型。行事でない物に会場、協賛、当番表を付けない
  expect(await start("試しの会費の集め直し")).toEqual({ kind: "event", tasks: ["announcement", "day", "report"] });
  // 予定に無い物は、一年の予定に足す
  expect(await env.DB.prepare("SELECT title FROM ward_year_items WHERE ward_id = ? AND title = ?").bind(ward.wardId, "試しの会費の集め直し").first()).not.toBeNull();
  // 一年の予定の物は、その予定の型
  expect((await start("定期総会")).kind).toBe("general_meeting");
  expect((await start("会費の集金")).tasks).toEqual(["announcement", "day", "report"]);
  expect((await start("秋の行事")).tasks).toContain("venue");
  expect(await (await postForm(realApp, `${root}/projects`, { title: "", year: "2026" }, cookie)).headers.get("location")).toContain("error=need_title");
});
