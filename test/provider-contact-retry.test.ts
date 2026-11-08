import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { PROVIDER_CONTACT_FIXTURE } from "../fixtures/provider-contact";
import { allowSend, CONTACT_WARD, messages, receiveContact } from "../src/contact/store";
import { WardBucket } from "../src/core/storage";
import { get, postForm, realApp, withEnv } from "./helpers";

const text = "  試しの問い合わせの書き足しです。\n<資料について>&追加の質問です。  ";
const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
async function fixture() {
  const received = await receiveContact(env.DB, { ...PROVIDER_CONTACT_FIXTURE, kind: "access" });
  return { ...received, path: `/contact/${received.token}` };
}
const noVerification = () => withEnv({ TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });

it("書き足しの送信確認が失敗しても文を残し、確認をやり直すと一件だけ届く", async () => {
  const contact = await fixture();
  const bindings = withEnv({ TURNSTILE_SITE_KEY: "fictional-site-key", TURNSTILE_SECRET_KEY: "fictional-secret-key" });
  let verified = false;
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: verified, action: "contact", hostname: "localhost" }));
  try {
    const form = { body: text, "cf-turnstile-response": "fictional-response" };
    const failed = await postForm(realApp, contact.path, form, undefined, bindings);
    expect(failed.status).toBe(403);
    expect(failed.headers.get("location")).toBeNull();
    expect(failed.headers.get("cache-control")).toContain("no-store");
    expect(failed.headers.get("x-robots-tag")).toBe("noindex");
    const html = await failed.text();
    expect(html).toContain(`>${escaped}</textarea>`);
    expect(html).toContain("送信の確認ができませんでした");
    expect(html).toContain('class="cf-turnstile"');
    expect(await messages(env.DB, contact.id)).toHaveLength(1);

    verified = true;
    const saved = await postForm(realApp, contact.path, form, undefined, bindings);
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`${contact.path}?sent=1`);
    expect(await messages(env.DB, contact.id)).toHaveLength(2);
    expect((await messages(env.DB, contact.id)).filter((message) => message.body === text.trim())).toHaveLength(1);
    const after = await (await get(realApp, saved.headers.get("location")!, undefined, bindings)).text();
    expect(after).toContain("書き足した内容を送りました");
    expect(after).not.toContain(`>${escaped}</textarea>`);
  } finally {
    request.mockRestore();
  }
});

it("写真の入力に誤りがあっても文を残し、未送信の写真を保存しない", async () => {
  const contact = await fixture();
  const form = new FormData();
  form.set("body", text);
  form.set("photo", new File(["fictional-file"], "試しの写真.heic", { type: "image/heic" }));
  const response = await realApp.request(contact.path, { method: "POST", headers: { origin: "http://localhost" }, body: form }, noVerification());
  expect(response.status).toBe(400);
  const html = await response.text();
  expect(html).toContain(`>${escaped}</textarea>`);
  expect(html).toContain("写真は選び直してください");
  expect(await messages(env.DB, contact.id)).toHaveLength(1);
  expect((await new WardBucket(env.ORIGINALS, CONTACT_WARD).list(`contacts/${contact.id}`)).keys).toHaveLength(0);
});

it("送信間隔の制限でも文を残し、閉じた受付には書き足すフォームを返さない", async () => {
  const contact = await fixture();
  for (let i = 0; i < 5; i++) await allowSend(env.DB, `thread:${contact.id}`);
  const response = await postForm(realApp, contact.path, { body: text }, undefined, noVerification());
  expect(response.status).toBe(429);
  expect(await response.text()).toContain(`>${escaped}</textarea>`);
  expect(await messages(env.DB, contact.id)).toHaveLength(1);
  await env.DB.prepare("UPDATE provider_contacts SET closed_at = ? WHERE ward_id = ? AND contact_id = ?")
    .bind(new Date().toISOString(), CONTACT_WARD, contact.id).run();
  const closed = await postForm(realApp, contact.path, { body: text }, undefined, noVerification());
  expect(closed.status).toBe(400);
  expect(await closed.text()).not.toContain('name="body"');
  expect(await messages(env.DB, contact.id)).toHaveLength(1);
});
