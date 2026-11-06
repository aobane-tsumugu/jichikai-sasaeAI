import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("画面を開いたあとに処理が進んで取り下げられなかったときは、成功と知らせない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: "架空の連絡.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の会場の連絡") }],
  });
  const root = `/${ward.slug}/admin/intake`;
  const initialPage = await (await get(realApp, `${root}/received`, cookie)).text();
  expect(initialPage).toContain(`${root}/${received.jobId}/withdraw`);
  // ボタンのある画面を開いた後、裏の処理が繋げる段階へ進んだ場面。
  await env.DB.prepare("UPDATE jobs SET status = 'connecting' WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, received.jobId).run();
  const response = await postForm(realApp, `${root}/${received.jobId}/withdraw`, {}, cookie);
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  expect(new URL(location, "http://localhost").searchParams.has("error")).toBe(true);
  const page = await (await get(realApp, location, cookie)).text();
  expect(page).toContain("取り下げられませんでした。");
  expect(page).toContain("消す希望");
  expect(page).not.toContain("取り下げました。");
  expect((await get(realApp, `${root}/originals/${received.received[0]!.originalId}`, cookie)).status).toBe(200);
});
