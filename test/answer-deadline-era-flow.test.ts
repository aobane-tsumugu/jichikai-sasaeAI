import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { getAnswerDeadline } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("試しの案内の和暦の締切をその年で保存し、日本時間の翌日に返事の受付を終える", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-20T03:00:00Z"));
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, {
      kind: "event", title: "試しの年度末の集まり", year: 2026, accountId: account.accountId,
    });
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "試しの案内", scope: "public", basedOn: project.stateVersion,
      body: JSON.stringify({ text: "試しの集まりの出欠をお知らせください。", items: [
        { key: "date_time", content: "2027年2月10日" },
        { key: "due", content: "令和9年2月1日まで" },
      ] }),
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
      WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("試しの案内がありません。");
    expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
    expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBe("2027-02-01");

    const publicPath = `/${ward.slug}/answer/${project.projectId}`;
    vi.setSystemTime(new Date("2027-02-01T14:59:00Z"));
    const onDeadline = await (await get(realApp, publicPath)).text();
    expect(onDeadline).toContain(`action="${publicPath}"`);
    expect(onDeadline).not.toContain("返事の受付は終わりました");
    vi.setSystemTime(new Date("2027-02-01T15:01:00Z"));
    expect(await (await get(realApp, publicPath)).text()).toContain("返事の受付は終わりました");
    const late = await postForm(realApp, publicPath, {
      household: "田中", district: "1班", children_count: "0", adults_count: "1", seniors_count: "0",
    });
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("返事の受付は終わりました");
  } finally {
    vi.useRealTimers();
  }
});
