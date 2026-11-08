import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("行事を閉じると実行委員と班長のページと元の資料を開けず、開き直すと同じ入室情報で開ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "閉じる行事", year: 2026, accountId: account.accountId });
  const admin = `/${ward.slug}/admin`;
  const space = `/${ward.slug}/space/${project.projectId}`;
  expect((await postForm(realApp, `${admin}/space/${project.projectId}/open`, { passphrase: "試しの合言葉です" }, cookie)).status).toBe(200);
  const entered = await postForm(realApp, `${space}/enter`, { passphrase: "試しの合言葉です" });
  const member = cookieFrom(entered, `space_${project.projectId}`);
  expect(member).not.toBeNull();
  const original = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "space", parts: [
    { kind: "file", filename: "空間の記録.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("試しの実行委員と班長のページの資料です") },
  ] });
  const file = `${space}/file/${original.received[0]!.originalId}`;
  expect((await get(realApp, space, member!)).status).toBe(200);
  expect((await get(realApp, file, member!)).status).toBe(200);

  expect((await postForm(realApp, `${admin}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const closed = await get(realApp, space, member!);
  expect(closed.status).toBe(403);
  expect(await closed.text()).toContain("役員が開けないようにしました。役員に聞いてください");
  expect((await get(realApp, file, member!)).status).toBe(403);

  await env.DB.prepare("UPDATE projects SET closed_at = NULL, closed_by_account_id = NULL WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).run();
  expect((await get(realApp, space, member!)).status).toBe(200);
  expect((await get(realApp, file, member!)).status).toBe(200);
});
