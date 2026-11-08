import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("電話の返事で参加するを選んで人数を空けると、何を直せば通るかを一文で言い、入れた名前は残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの秋祭り", year: 2026, accountId: account.accountId });
  const path = `/${ward.slug}/admin/answers/${project.projectId}/phone`;
  const blank = await postForm(realApp, path, { household: "電話の世帯", district: "", attend: "yes", children_count: "", adults_count: "", seniors_count: "" }, cookie);
  expect(blank.status).toBe(400);
  const html = await blank.text();
  expect(html).toContain("「参加する」のときは、参加する人数を入れてください。何人か分からないときは、ひとまず1と入れてかまいません。");
  expect(html).toContain('value="電話の世帯"');
  const noName = await postForm(realApp, path, { household: "", district: "", attend: "no" }, cookie);
  expect(await noName.text()).toContain("世帯の代表者のお名前が入っていません。");
  const ok = await postForm(realApp, path, { household: "電話の世帯", district: "", attend: "yes", children_count: "", adults_count: "1", seniors_count: "" }, cookie);
  expect(ok.status).toBe(303);
});

it("当日の前に終わりにする画面を開くと、まだ終わっていないことと戻る道が一番上に出て、終わりにするボタンは小さくなる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの日のない訓練", year: 2026, accountId: account.accountId });
  const html = await (await realApp.request(`/${ward.slug}/admin/close/${project.projectId}`, { headers: { cookie } }, env)).text();
  expect(html).toContain("試しの日のない訓練は、まだ終わっていません");
  expect(html).toContain("まだ当日が決まっていません。終わりにするのは、当日が済んで、住民に報告を載せるときです。");
  expect(html).toContain('<button class="secondary">終わりにする</button>');
});

it("案内をまだ知らせていない準備の出欠の返事の画面は、まだ無い回答票を撮れと言わず、やることへ戻る道を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しのまだ知らせていない祭り", year: 2026, accountId: account.accountId });
  const html = await (await realApp.request(`/${ward.slug}/admin/answers/${project.projectId}`, { headers: { cookie } }, env)).text();
  expect(html).toContain("試しのまだ知らせていない祭りは、まだ住民に案内を知らせていません。");
  expect(html).toContain(`href="/${ward.slug}/admin/projects/${project.projectId}/map">試しのまだ知らせていない祭りのやることを開く</a>`);
  expect(html).not.toContain("回答票が手元にあれば、撮って送れます。");
});

it("問い合わせの一件の画面で、電話で返事をした時の欄は大きい送るボタンと別のフォームにあり、書いても大きいボタンでは送られない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  await env.DB.prepare(`INSERT INTO inquiry_records (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_at, line_source_type, line_user_id, line_sender_label)
    VALUES ('q-fold', ?, '2026-11-07T01:00:00.000Z', 'inquiry', '駐車場はありますか', '', 0, '2026-11-07T01:00:00.000Z', 'user', 'U-fictional-fold', '四郎')`).bind(ward.wardId).run();
  const html = await (await realApp.request(`/${ward.slug}/admin/inquiries/q-fold`, { headers: { cookie } }, env)).text();
  const mainStart = html.indexOf('<textarea id="answer"');
  const mainEnd = html.indexOf("</form>", mainStart);
  expect(mainStart).toBeGreaterThan(0);
  expect(html.slice(mainStart, mainEnd)).not.toContain('name="phoneAnswer"');
  expect(html.slice(mainEnd)).toContain('name="phoneAnswer"');
  expect(html.slice(mainEnd)).toContain('value="record"');
});

it("住民向けの連絡先が無い時は、トップの役員が見ないと進まないことに、連絡先を入れる道を出す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const html = await (await realApp.request(`/${ward.slug}/admin/`, { headers: { cookie } }, env)).text();
  expect(html).toContain("住民向けのページに出す自治会の連絡先が、まだ入っていません。");
  expect(html).toContain(`href="/${ward.slug}/admin/settings/info">連絡先を入れる</a>`);
});
