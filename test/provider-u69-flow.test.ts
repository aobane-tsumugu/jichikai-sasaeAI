import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { PROVIDER_CONTACT_FIXTURE as sample } from "../fixtures/provider-contact";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { appendMessage, CONTACT_WARD, contactById, receiveContact } from "../src/contact/store";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { AI_CREDENTIAL_ALERT, AI_CREDENTIAL_MESSAGE } from "../src/ops/ai-alert";
import { OPS_COOKIE } from "../src/ops/session";
import { cookieFrom, get, OPS_ID, OPS_PASSWORD, opsEnv, postForm, realApp } from "./helpers";

it("提供側が署名済みの鍵の失敗に対応し、指定の受付と写真を消す", async () => {
  const owner = await seedAdmin(env.DB), other = await seedAdmin(env.DB);
  const contact = await receiveContact(env.DB, { ...sample, kind: "access" });
  const kept = await receiveContact(env.DB, { ...sample, kind: "usage" });
  const record = await contactById(env.DB, contact.id);
  expect(record).not.toBeNull();
  await appendMessage(opsEnv, record!, "person", sample.more,
    new File([new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes)], FIRST_SLICE.answerSheetFilename, { type: "image/jpeg" }));
  const photo = await env.DB.prepare("SELECT photo_key FROM provider_contact_messages WHERE ward_id = ? AND contact_id = ? AND photo_key IS NOT NULL")
    .bind(CONTACT_WARD, contact.id).first<{ photo_key: string }>();
  expect(photo).not.toBeNull();
  const bucket = new WardBucket(env.ORIGINALS, CONTACT_WARD);
  const day = new Date();
  await writeDailyWardSnapshots(opsEnv, day);
  const snapshot = `snapshots/daily/${day.toISOString().slice(0, 10)}.json`;
  const before = await (await bucket.get(snapshot))!.text();
  expect(before).toContain(contact.id);

  const photoPath = `/ops/photo-settings/${owner.ward.wardId}`;
  const deletionPath = `/ops/contact-deletions/${contact.id}`;
  expect((await postForm(realApp, deletionPath, {}, owner.cookie, opsEnv)).status).toBe(303);
  expect(await contactById(env.DB, contact.id)).not.toBeNull();
  const login = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv);
  const cookie = cookieFrom(login, OPS_COOKIE)!;
  expect(cookie).toBeTruthy();
  expect(login.headers.get("set-cookie")).toContain("Path=/ops");
  const home = await (await get(realApp, "/ops/", cookie, opsEnv)).text();
  expect(home).toContain('href="/ops/contact-deletions"');
  const wardPage = await (await get(realApp, `/ops/wards/${owner.ward.slug}`, cookie, opsEnv)).text();
  expect(wardPage).not.toContain(`href="${photoPath}"`);
  expect((await get(realApp, photoPath, cookie, opsEnv)).status).toBe(404);
  expect((await postForm(realApp, photoPath, {}, cookie, opsEnv)).status).toBe(404);
  expect((await get(realApp, `/hooks/photo-settings/${owner.ward.wardId}`, cookie, opsEnv)).status).toBe(404);

  const vaultId = "vault-fictional-u69", credentialId = "credential-fictional-u69";
  await env.DB.prepare("INSERT INTO ward_ai (ward_id, vault_id, credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(owner.ward.wardId, vaultId, credentialId, day.toISOString(), day.toISOString()).run();
  const secret = `whsec_${btoa("fictional-u69-webhook-signing-key")}`;
  const bindings = Object.create(opsEnv, { ANTHROPIC_WEBHOOK_SIGNING_KEY: { value: secret } }) as typeof opsEnv;
  const payload = JSON.stringify({ type: "event", id: "whe-fictional-u69", data: {
    type: "vault_credential.refresh_failed", id: credentialId, vault_id: vaultId, detail: sample.body,
  } });
  const sendFailure = (signed: boolean) => {
    const now = new Date(), id = `msg_${crypto.randomUUID()}`;
    return realApp.request("/hooks/anthropic", { method: "POST", body: payload, headers: {
      "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": signed ? new Webhook(secret).sign(id, now, payload) : "v1,AAAA",
    } }, bindings);
  };
  expect((await sendFailure(false)).status).toBe(400);
  expect(await env.DB.prepare("SELECT value FROM ward_settings WHERE ward_id = ? AND key = ?")
    .bind(owner.ward.wardId, AI_CREDENTIAL_ALERT).first()).toBeNull();
  expect((await sendFailure(true)).status).toBe(204);
  expect((await sendFailure(true)).status).toBe(204);
  const alert = await env.DB.prepare("SELECT value, updated_at FROM ward_settings WHERE ward_id = ? AND key = ?")
    .bind(owner.ward.wardId, AI_CREDENTIAL_ALERT).first<{ value: string; updated_at: string }>();
  expect(alert?.value).toBe(AI_CREDENTIAL_MESSAGE);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ward_settings WHERE ward_id = ? AND key = ?")
    .bind(owner.ward.wardId, AI_CREDENTIAL_ALERT).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT value FROM ward_settings WHERE ward_id = ? AND key = ?")
    .bind(other.ward.wardId, AI_CREDENTIAL_ALERT).first()).toBeNull();
  const alerts = await (await get(realApp, "/ops/alerts", cookie, opsEnv)).text();
  expect(alerts).toContain(owner.ward.name);
  expect(alerts).toContain(AI_CREDENTIAL_MESSAGE);
  expect(alerts).toContain(`/ops/wards/${owner.ward.slug}/queue`);
  expect(alerts).not.toContain(credentialId);
  expect(alerts).not.toContain(sample.body);
  expect((await postForm(realApp, `/ops/alerts/wards/${owner.ward.wardId}/ai-resolved`, { updatedAt: alert!.updated_at }, cookie, opsEnv)).status).toBe(200);
  expect(await env.DB.prepare("SELECT value FROM ward_settings WHERE ward_id = ? AND key = ?")
    .bind(owner.ward.wardId, AI_CREDENTIAL_ALERT).first()).toBeNull();

  const invitation = await postForm(realApp, `/ops/contacts/${contact.id}/invite`, {
    wardId: owner.ward.wardId, accountId: owner.account.accountId, how: sample.how,
  }, cookie, opsEnv);
  expect(invitation.status).toBe(200);
  const invited = await contactById(env.DB, contact.id);
  expect(invited?.grant_id).toBeTruthy();
  const deletionList = await (await get(realApp, "/ops/contact-deletions", cookie, opsEnv)).text();
  expect(deletionList).toContain(`action="${deletionPath}"`);
  expect(deletionList).toContain("以前の日次の写しは残る");
  const deleted = await postForm(realApp, deletionPath, {}, cookie, opsEnv);
  expect(deleted.status).toBe(200);
  expect(await deleted.text()).toContain("以前の日次の写しは残っています");
  expect(await contactById(env.DB, contact.id)).toBeNull();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_contact_messages WHERE ward_id = ? AND contact_id = ?")
    .bind(CONTACT_WARD, contact.id).first("n")).toBe(0);
  expect(await bucket.head(photo!.photo_key)).toBeNull();
  expect(await env.DB.prepare("SELECT revoked_at FROM sign_in_links WHERE ward_id = ? AND link_id = ?")
    .bind(owner.ward.wardId, invited!.grant_id).first("revoked_at")).toBeTruthy();
  expect(await env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND account_id = ?")
    .bind(owner.ward.wardId, owner.account.accountId).first()).not.toBeNull();
  expect((await get(realApp, `/contact/${contact.token}`, undefined, opsEnv)).status).toBe(404);
  expect(await contactById(env.DB, kept.id)).not.toBeNull();
  expect(await (await bucket.get(snapshot))!.text()).toBe(before);
  expect((await postForm(realApp, deletionPath, {}, cookie, opsEnv)).status).toBe(404);
});
