import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { get, realApp } from "./helpers";

describe("印刷用ページ", () => {
  it("当番表と配置図の紙は、案内の本文ではなく今年の当番と配置から作る", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    const source = { kind: "person" as const, accountId: account.accountId };
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data: { slot: "9:00〜10:30", task: "設営", assignee: "架空 当番さん" }, source, confidence: "high", packVersion: "print-test@1",
    });
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "layout", data: { spot: "受付", position: "玄関の右" }, source, confidence: "high", packVersion: "print-test@1",
    });
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "架空の案内", scope: "public", body: JSON.stringify({ text: "案内だけに書いた架空の本文", items: [] }), basedOn: 0,
    });
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id WHERE d.ward_id = ? AND d.project_id = ?`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    await env.DB.prepare(`INSERT INTO publication_records (ward_id, publication_id, project_id, document_id, version_id, version_no,
        line_status, published_at, published_by_account_id) VALUES (?, 'pub-print', ?, ?, ?, ?, 'not_sent', ?, ?)`)
      .bind(ward.wardId, project.projectId, version!.document_id, version!.version_id, version!.version_no, "2026-10-01T00:00:00.000Z", account.accountId).run();

    const base = `/${ward.slug}/admin/print/${project.projectId}/${version!.document_id}/${version!.version_no}`;
    const duty = await (await get(realApp, `${base}/duty`, cookie)).text();
    expect(duty).toContain("架空 当番さん");
    expect(duty).toContain("玄関の右");
    expect(duty).not.toContain("案内だけに書いた架空の本文");
    const announcement = await (await get(realApp, `${base}/announcement`, cookie)).text();
    expect(announcement).toContain("案内だけに書いた架空の本文");
  });
});
