import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { PROVIDER_CONTACT_FIXTURE as sample } from "../fixtures/provider-contact";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { CONTACT_WARD, purgeContactPhotos, type ContactBindings } from "../src/contact/store";
import { OPS_COOKIE } from "../src/ops/session";
import { cookieFrom, get, OPS_ID, OPS_PASSWORD, opsEnv, postForm, realApp } from "./helpers";

it("登録なしで問い合わせ、書き足しと写真、提供側の確認、24時間の入口、受付を閉じて30日後の消去まで進む", async () => {
  const owner = await seedAdmin(env.DB), another = await seedAdmin(env.DB);
  const sentMail: Array<{ to: string; subject: string; text: string }> = [];
  const binding: ContactBindings = { CONTACT_MAIL: { async send(message) { sentMail.push(message); } } };
  const bindings = Object.create(opsEnv, { CONTACT_MAIL: { value: binding.CONTACT_MAIL } }) as typeof opsEnv;
  const submission = async () => {
    const html = await (await get(realApp, "/contact", undefined, bindings)).text();
    const id = /name="submission_id" value="([^"]+)"/.exec(html)?.[1];
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return id!;
  };
  const submissionId = await submission();
  const input = { ...sample, kind: "access", submission_id: submissionId };
  const invalid = await postForm(realApp, "/contact", { ...input, name: "   ", kind: "broken" }, undefined, bindings);
  expect(invalid.status).toBe(400);
  const invalidHtml = await invalid.text();
  for (const text of [sample.wardName, sample.reach, sample.body, submissionId, "「お名前」に60文字まででお名前を入れてください。", 'value="   "']) expect(invalidHtml).toContain(text);
  expect(invalidHtml).toMatch(/<input[^>]*name="kind"[^>]*value="broken"[^>]*checked/);
  const started = await postForm(realApp, "/contact", input, undefined, bindings);
  expect(started.status).toBe(201);
  expect(started.headers.get("cache-control")).toContain("no-store");
  const sentHtml = await started.text();
  const path = /class="button contact-thread-link" href="([^"]+)"/.exec(sentHtml)?.[1];
  expect(path).toMatch(/^\/contact\/[A-Za-z0-9_-]{43}$/);
  expect(sentMail).toHaveLength(1);
  expect(sentMail[0]?.to).toBe(sample.reach);
  expect(sentMail[0]?.text).toContain(path);
  const record = await env.DB.prepare("SELECT contact_id, receipt, token_hash FROM provider_contacts WHERE ward_id = ? AND reach = ?")
    .bind(CONTACT_WARD, sample.reach).first<{ contact_id: string; receipt: string; token_hash: string }>();
  expect(record?.receipt).toMatch(/^\d{12}$/);
  expect(record?.token_hash).not.toBe(path!.split("/").pop());
  // 再読込を繰り返しても連続送信の制限に進まず、受付、本文、メールは一つのまま。
  for (let i = 0; i < 6; i++) {
    const repeated = await postForm(realApp, "/contact", input, undefined, bindings);
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toContain(`href="${path}"`);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_contacts WHERE ward_id = ? AND reach = ?").bind(CONTACT_WARD, sample.reach).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_contact_messages WHERE ward_id = ? AND contact_id = ?").bind(CONTACT_WARD, record!.contact_id).first("n")).toBe(1);
  expect(sentMail).toHaveLength(1);
  expect((await get(realApp, `/contact/${record!.receipt}`, undefined, bindings)).status).toBe(404);
  expect((await get(realApp, `/contact/${"A".repeat(43)}`, undefined, bindings)).status).toBe(404);
  expect((await get(realApp, `/ops/contacts/${record!.contact_id}`, undefined, bindings)).status).toBe(303);

  const form = new FormData();
  form.set("body", sample.more);
  form.set("photo", new File([new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes)], FIRST_SLICE.answerSheetFilename, { type: "image/jpeg" }));
  const more = await realApp.request(path!, { method: "POST", headers: { origin: "http://localhost" }, body: form }, bindings);
  expect(more.status).toBe(303);
  const photo = await env.DB.prepare("SELECT message_id, photo_key FROM provider_contact_messages WHERE ward_id = ? AND contact_id = ? AND photo_key IS NOT NULL")
    .bind(CONTACT_WARD, record!.contact_id).first<{ message_id: string; photo_key: string }>();
  const bucket = new WardBucket(env.ORIGINALS, CONTACT_WARD);
  expect(await bucket.head(photo!.photo_key)).not.toBeNull();
  expect((await get(realApp, `${path}/photos/${photo!.message_id}`, undefined, bindings)).status).toBe(200);

  const login = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, bindings);
  const cookie = cookieFrom(login, OPS_COOKIE)!;
  expect(cookie).toBeTruthy();
  const ops = `/ops/contacts/${record!.contact_id}`;
  expect(await (await get(realApp, "/ops/contacts", cookie, bindings)).text()).toContain(record!.receipt.slice(0, 4));
  const selected = await (await get(realApp, `${ops}?wardId=${owner.ward.wardId}`, cookie, bindings)).text();
  expect(selected).toContain(owner.account.name);
  expect(selected).toContain('name="how" required');
  expect(selected).not.toContain('name="person"');
  const confirm = { wardId: owner.ward.wardId, accountId: owner.account.accountId, how: sample.how };
  expect((await postForm(realApp, `${ops}/invite`, { ...confirm, how: "" }, cookie, bindings)).status).toBe(400);
  expect((await postForm(realApp, `${ops}/invite`, { ...confirm, accountId: another.account.accountId }, cookie, bindings)).status).toBe(400);
  const replied = await postForm(realApp, `${ops}/reply`, { body: sample.reply }, cookie, bindings);
  expect(replied.status).toBe(200);
  expect(sentMail).toHaveLength(2);
  expect(sentMail[1]?.to).toBe(sample.reach);
  expect(sentMail[1]?.text).not.toContain(sample.reply);
  expect(await (await get(realApp, path!, undefined, bindings)).text()).toContain(sample.reply);

  const grant = await postForm(realApp, `${ops}/invite`, confirm, cookie, bindings);
  expect(grant.status).toBe(200);
  expect(await grant.text()).toContain("リンクを出しました");
  const linkRow = await env.DB.prepare("SELECT link_id, created_at, expires_at, created_by_provider FROM sign_in_links WHERE ward_id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(owner.ward.wardId, owner.account.accountId).first<{ link_id: string; created_at: string; expires_at: string; created_by_provider: number }>();
  expect(linkRow?.created_by_provider).toBe(1);
  expect(Date.parse(linkRow!.expires_at) - Date.parse(linkRow!.created_at)).toBe(24 * 3600_000);
  expect((await postForm(realApp, `${ops}/invite`, confirm, cookie, bindings)).status).toBe(400);
  const thread = await (await get(realApp, path!, undefined, bindings)).text();
  const invitation = /href="([^"]+\/admin\/invite\/[^"/]+)"/.exec(thread)?.[1];
  expect(invitation).toBeTruthy();
  const invitePath = new URL(invitation!).pathname;
  expect((await get(realApp, invitePath, undefined, bindings)).status).toBe(200);
  const entered = await postForm(realApp, `${invitePath}/password`, {}, undefined, bindings);
  expect(entered.status).toBe(200);
  const personCookie = cookieFrom(entered, "device")!;
  expect(personCookie).toBeTruthy();
  expect((await postForm(realApp, `${invitePath}/password`, {}, undefined, bindings)).status).toBe(400);
  const people = await (await get(realApp, `/${owner.ward.slug}/admin/settings/people`, personCookie, bindings)).text();
  expect(people).toContain("SasaeAIが");
  const audit = await env.DB.prepare("SELECT verified_how, target_ward_id, target_account_id FROM provider_contacts WHERE ward_id = ? AND contact_id = ?")
    .bind(CONTACT_WARD, record!.contact_id).first<{ verified_how: string; target_ward_id: string; target_account_id: string }>();
  expect(audit).toMatchObject({ verified_how: sample.how, target_ward_id: owner.ward.wardId, target_account_id: owner.account.accountId });

  expect((await postForm(realApp, "/contact", { ...sample, kind: "usage", reach: "" }, undefined, bindings)).status).toBe(400);
  const usageReach = `usage-${crypto.randomUUID()}@example.invalid`;
  const usage = await postForm(realApp, "/contact", { ...sample, kind: "usage", reach: usageReach, submission_id: await submission() }, undefined, bindings);
  expect(usage.status).toBe(201);
  const usageHtml = await usage.text();
  const anonymousPath = /class="button contact-thread-link" href="([^"]+)"/.exec(usageHtml)![1]!;
  const otherRecord = await env.DB.prepare("SELECT contact_id FROM provider_contacts WHERE ward_id = ? AND reach = ?")
    .bind(CONTACT_WARD, usageReach).first<{ contact_id: string }>();
  const otherOps = `/ops/contacts/${otherRecord!.contact_id}`;
  const otherHtml = await (await get(realApp, otherOps, cookie, bindings)).text();
  expect(otherHtml).not.toContain('name="how"');
  expect(otherHtml).toContain(`${otherOps}/close`);
  expect((await get(realApp, `${anonymousPath}/photos/${photo!.message_id}`, undefined, bindings)).status).toBe(404);
  expect((await postForm(realApp, `${otherOps}/invite`, confirm, cookie, bindings)).status).toBe(400);
  expect((await postForm(realApp, `${otherOps}/close`, {}, cookie, bindings)).status).toBe(200);

  const nextReach = `next-${crypto.randomUUID()}@example.invalid`;
  const next = await postForm(realApp, "/contact", { ...sample, kind: "access", reach: nextReach, submission_id: await submission() }, undefined, bindings);
  expect(next.status).toBe(201);
  const nextRecord = await env.DB.prepare("SELECT contact_id FROM provider_contacts WHERE ward_id = ? AND reach = ? AND closed_at IS NULL")
    .bind(CONTACT_WARD, nextReach).first<{ contact_id: string }>();
  const nextOps = `/ops/contacts/${nextRecord!.contact_id}`;
  expect((await postForm(realApp, `${nextOps}/invite`, { ...confirm, accountId: "new", newName: sample.newName }, cookie, bindings)).status).toBe(200);
  const newLink = await env.DB.prepare(`SELECT l.purpose, l.expires_at, l.created_at, l.created_by_provider FROM sign_in_links l JOIN accounts a
    ON a.ward_id = l.ward_id AND a.account_id = l.account_id WHERE l.ward_id = ? AND a.name = ?`)
    .bind(owner.ward.wardId, sample.newName).first<{ purpose: string; expires_at: string; created_at: string; created_by_provider: number }>();
  expect(newLink?.purpose).toBe("invite");
  expect(newLink?.created_by_provider).toBe(1);
  expect(Date.parse(newLink!.expires_at) - Date.parse(newLink!.created_at)).toBe(24 * 3600_000);
  expect((await postForm(realApp, `${nextOps}/close`, {}, cookie, bindings)).status).toBe(200);
  for (const kind of ["reply", "publish", "digest"]) await env.DB.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, ?, ?)")
    .bind(owner.ward.wardId, `line.delivery_alert.${kind}`, `${kind}を送れませんでした`).run();
  const alerts = await (await get(realApp, "/ops/alerts", cookie, bindings)).text();
  expect(alerts).toContain("replyを送れませんでした");
  expect(alerts).toContain("publishを送れませんでした");
  expect(alerts).toContain("digestを送れませんでした");
  for (let index = 0; index < 6; index++) {
    const limited = await postForm(realApp, path!, { body: sample.more }, undefined, bindings);
    expect(limited.status).toBe(index < 4 ? 303 : 429);
  }
  expect((await postForm(realApp, `${ops}/close`, {}, cookie, bindings)).status).toBe(200);
  expect((await postForm(realApp, path!, { body: sample.more }, undefined, bindings)).status).toBe(400);
  await env.DB.prepare("UPDATE provider_contacts SET closed_at = ? WHERE ward_id = ? AND contact_id = ?")
    .bind(new Date(Date.now() - 29 * 86400_000).toISOString(), CONTACT_WARD, record!.contact_id).run();
  await purgeContactPhotos(bindings);
  expect(await bucket.head(photo!.photo_key)).not.toBeNull();
  await env.DB.prepare("UPDATE provider_contacts SET closed_at = ? WHERE ward_id = ? AND contact_id = ?")
    .bind(new Date(Date.now() - 31 * 86400_000).toISOString(), CONTACT_WARD, record!.contact_id).run();
  await purgeContactPhotos(bindings);
  expect(await bucket.head(photo!.photo_key)).toBeNull();
  expect((await get(realApp, `${path}/photos/${photo!.message_id}`, undefined, bindings)).status).toBe(404);
});
