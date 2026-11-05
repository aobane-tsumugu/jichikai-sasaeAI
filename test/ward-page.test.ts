import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

// 架空の区で、同じ案内を二度配った後の区のページを確かめる。
async function publishTwice() {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
  for (const text of ["場所は広場です（変更前の架空の案内）", "場所はホールです（変更後の架空の案内）"]) {
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "架空の案内", scope: "public", body: JSON.stringify({ text, items: [] }), basedOn: project.stateVersion,
    });
  }
  const versions = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? ORDER BY v.version_no`)
    .bind(ward.wardId, project.projectId).all<{ document_id: string; version_id: string; version_no: number }>();
  expect(versions.results).toHaveLength(2);
  for (const [index, version] of versions.results.entries()) {
    await env.DB.prepare(`INSERT INTO publication_records (ward_id, publication_id, project_id, document_id, version_id, version_no,
        line_status, published_at, published_by_account_id) VALUES (?, ?, ?, ?, ?, ?, 'not_sent', ?, ?)`)
      .bind(ward.wardId, `pub-${index}`, project.projectId, version.document_id, version.version_id, version.version_no,
        `2026-10-0${index + 1}T00:00:00.000Z`, account.accountId).run();
  }
  return { ward, project };
}

describe("区のページ", () => {
  it("配り直した時は今の案内を先に出し、変更前の案内は畳んで後ろに置く", async () => {
    const { ward, project } = await publishTwice();
    const html = await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text();
    const current = html.indexOf("変更後の架空の案内");
    const folded = html.indexOf("<details>");
    expect(current).toBeGreaterThan(0);
    expect(folded).toBeGreaterThan(current);
    expect(html.indexOf("変更前の架空の案内")).toBeGreaterThan(folded);
  });

  it("今の案内を下げると、今の案内も変更前の案内も中身を出さない", async () => {
    const { ward, project } = await publishTwice();
    await env.DB.prepare("UPDATE publication_records SET unpublished_at = ? WHERE ward_id = ? AND publication_id = 'pub-1'")
      .bind("2026-10-03T00:00:00.000Z", ward.wardId).run();
    const response = await get(realApp, `/${ward.slug}/p/${project.projectId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("掲載を終えました");
    expect(html).not.toContain("変更後の架空の案内");
    expect(html).not.toContain("変更前の架空の案内");
  });
});

describe("報告と閉じる", () => {
  it("報告の下書きを頼む時は、保存できる下書きの形と元にした状態の番号を AI に伝える", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    const response = await postForm(realApp, `/${ward.slug}/admin/close/${project.projectId}/prepare`, {}, cookie);
    expect(response.status).toBe(303);
    const job = await env.DB.prepare("SELECT instruction FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'report'")
      .bind(ward.wardId, project.projectId).first<{ instruction: string }>();
    expect(job?.instruction).toContain("{text: string, items:");
    expect(job?.instruction).toContain("based_on_state_version");
    expect(job?.instruction).toContain("対象の文書: report。範囲: public。");
  });
});

describe("役員の仕事と活動の紹介", () => {
  it("閉じた後に、選んだ仕事と役員が直した文だけを区のページに載せる", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    const closePage = `/${ward.slug}/admin/close/${project.projectId}`;
    expect((await get(realApp, closePage, cookie)).status).toBe(200);
    const tasks = await env.DB.prepare("SELECT task_id, name FROM project_close_map WHERE ward_id = ? AND project_id = ? ORDER BY period, task_id")
      .bind(ward.wardId, project.projectId).all<{ task_id: string; name: string }>();
    expect(tasks.results.length).toBeGreaterThan(1);
    const [chosen, skipped] = tasks.results;
    const form = {
      action: "publish", introduction: "会場の予約と案内を役員が受け持ちました（架空）。", membershipBurden: "年に一度の当番があります（架空）。",
      membershipBenefit: "行事の案内が早く届きます（架空）。", taskId: chosen!.task_id,
    };
    // 閉じる前は載せられない。
    expect((await postForm(realApp, `${closePage}/activity`, form, cookie)).status).toBe(400);
    await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind("2026-11-01T00:00:00.000Z", ward.wardId, project.projectId).run();
    expect((await postForm(realApp, `${closePage}/activity`, form, cookie)).status).toBe(303);
    const html = await (await get(realApp, `/${ward.slug}/work/${project.projectId}`)).text();
    expect(html).toContain("会場の予約と案内を役員が受け持ちました（架空）。");
    expect(html).toContain("記録にある仕事 1 件");
    expect(html).toContain(chosen!.name);
    expect(html).not.toContain(skipped!.name);
    // 案内を載せていない行事なので、案内のページへのリンクは出さない。
    expect(html).not.toContain("この行事の案内を見る");
    expect(await (await get(realApp, `/${ward.slug}/`)).text()).toContain(`/${ward.slug}/work/${project.projectId}`);
  });
});
