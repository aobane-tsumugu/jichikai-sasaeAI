import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { CRON } from "../src/core/cron";
import { seedAdmin } from "../src/core/testing";
import { requestProjectDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { lookupPaperCode, makePaperCode, makeProjectPaperCode } from "../src/print/qr";
import { postForm, realApp } from "./helpers";

it("先の行事や文書と最後の行事を消しても、印刷した番号の指す先を変えず使い直さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const create = () => createProject(env.DB, w, { kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const first = await create(), second = await create(), third = await create();
  // 文書も保存した番号を使う。配る前の文書を取り除いても、配った文書へ戻れる。
  const unusedId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO documents (ward_id, project_id, document_id, kind, title, scope) VALUES (?, ?, ?, 'notice', ?, 'public')")
    .bind(w, second.projectId, unusedId, fixture.draftTitle).run();
  expect(await saveDocument(env.DB, w, second.projectId, account.accountId, {
    kind: "announcement", title: fixture.draftTitle, scope: "public", basedOn: 0,
    body: JSON.stringify({ text: fixture.publicAnnouncement, items: [{ key: "place", content: fixture.previousPlace }] }),
  })).toBe(true);
  const document = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(w, second.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect(document).not.toBeNull();
  expect((await postForm(realApp, `/${ward.slug}/admin/publish/${second.projectId}/send`, {
    documentId: document!.document_id, versionId: document!.version_id, versionNo: String(document!.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const code = await makePaperCode(env.DB, w, second.projectId, document!.document_id, 1);
  expect(code).toBe("P2-D2-V1");
  expect(await makeProjectPaperCode(env.DB, w, third.projectId)).toBe("P3-D0-V1");
  await env.DB.prepare("DELETE FROM documents WHERE ward_id = ? AND project_id = ? AND document_id = ?").bind(w, second.projectId, unusedId).run();
  const nextId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO documents (ward_id, project_id, document_id, kind, title, scope) VALUES (?, ?, ?, 'notice', ?, 'public')")
    .bind(w, second.projectId, nextId, fixture.draftTitle).run();
  expect(await makePaperCode(env.DB, w, second.projectId, nextId, 1)).toBe("P2-D3-V1");
  expect(await lookupPaperCode(env.DB, w, "P2-D1-V1")).toBeNull();

  for (const project of [first, third]) {
    expect(await requestProjectDeletion(env.DB, w, project.projectId)).toBe(true);
    for (let i = 0; i < 20; i++) {
      if (!await env.DB.prepare("SELECT 1 AS found FROM ops_deletion_queue WHERE ward_id = ? AND target_id = ?")
        .bind(w, project.projectId).first()) break;
      await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
    }
    expect(await env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND project_id = ?").bind(w, project.projectId).first()).toBeNull();
  }
  expect(await makePaperCode(env.DB, w, second.projectId, document!.document_id, 1)).toBe(code);
  expect(await lookupPaperCode(env.DB, w, code!)).toEqual({ projectId: second.projectId, documentId: document!.document_id, version: 1 });
  expect(await makeProjectPaperCode(env.DB, w, second.projectId)).toBe("P2-D0-V1");
  expect(await lookupPaperCode(env.DB, w, "P1-D0-V1")).toBeNull();
  expect(await lookupPaperCode(env.DB, w, "P3-D0-V1")).toBeNull();
  expect(await makeProjectPaperCode(env.DB, w, (await create()).projectId)).toBe("P4-D0-V1");
  const other = await seedAdmin(env.DB);
  expect(await lookupPaperCode(env.DB, other.ward.wardId, code!)).toBeNull();
});
