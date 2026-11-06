import { sha256Hex } from "../core/password";
import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import type { PropsWithChildren } from "hono/jsx";
import type { AppEnv, Env } from "../env";
import { Layout, Notice } from "../core/ui";
import { formatJst } from "../core/time";
import { WardBucket } from "../core/storage";
import { allowSend, appendMessage, CONTACT_WARD, contactBindings, contactByToken, contactInvitationToken, KINDS, messages, receiveContact, type Contact, type ContactKind, type Message } from "./store";

export const ContactPage = (props: PropsWithChildren<{ title: string; ops?: boolean }>) => <Layout title={props.title} siteName={props.ops ? "SasaeAI 運用の画面" : "SasaeAI"} noindex>
  {props.ops ? <a class="quiet" href="/ops/contacts">問い合わせの一覧へ戻る</a> : null}{props.children}
</Layout>;
export const receiptLabel = (receipt: string) => receipt.replace(/(\d{4})(\d{4})(\d{4})/, "$1-$2-$3");
export function ContactError(props: { message: string; href?: string; ops?: boolean }) {
  return <ContactPage title="送っていません" ops={props.ops}><h1>送っていません</h1><Notice error>{props.message}</Notice>
    <section class="next"><strong>次は</strong><p>元の画面に戻って確かめ、もう一度送ってください。</p><a class="button" href={props.href ?? "/contact"}>元の画面へ戻る</a></section></ContactPage>;
}
const Turnstile = (props: { sitekey?: string }) => props.sitekey ? <><div class="cf-turnstile" data-sitekey={props.sitekey} data-action="contact" /><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer /></> : null;
function sitekey(env: Env) {
  const bindings = contactBindings(env);
  return bindings.TURNSTILE_SECRET_KEY && bindings.TURNSTILE_SITE_KEY ? bindings.TURNSTILE_SITE_KEY : undefined;
}
async function verified(c: Context<AppEnv>, form: Record<string, string | File | (string | File)[]>) {
  const bindings = contactBindings(c.env);
  if (!sitekey(c.env)) return true;
  const token = form["cf-turnstile-response"];
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: new URLSearchParams({ secret: bindings.TURNSTILE_SECRET_KEY!, response: token }), signal: AbortSignal.timeout(10000),
    });
    const result: unknown = await response.json();
    return response.ok && typeof result === "object" && result !== null && "success" in result && result.success === true
      && "action" in result && result.action === "contact" && "hostname" in result && result.hostname === new URL(c.req.url).hostname;
  } catch { return false; }
}
export async function mailNotice(env: Env, contact: Pick<Contact, "reach" | "receipt">, link?: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.reach)) return "manual" as const;
  const mail = contactBindings(env).CONTACT_MAIL;
  if (!mail) return "manual" as const;
  try {
    await mail.send({ to: contact.reach, subject: `SasaeAI 受付${receiptLabel(contact.receipt)}`,
      text: link ? `問い合わせを受け取りました。受付番号${receiptLabel(contact.receipt)}\nやりとりの画面はこちらです。他の人には渡さないでください。\n${link}`
        : `受付番号${receiptLabel(contact.receipt)}\nやりとりの画面に返事を書きました。受け付けたときのリンクから開いてください。` });
    return "sent" as const;
  } catch { return "failed" as const; }
}
export function Conversation(props: { contact: Contact; entries: Message[]; photoBase: string }) {
  const expired = props.contact.closed_at && Date.parse(props.contact.closed_at) + 30 * 86400_000 <= Date.now();
  return <div class="contact-messages">{props.entries.map((m) => <section class="panel">
    <strong>{m.sender === "provider" ? "SasaeAI" : "問い合わせた方"}</strong><p class="muted">{formatJst(m.created_at)}</p>
    {m.body ? <p class="contact-body">{m.body}</p> : null}
    {m.photo_key && !expired ? <a class="quiet" href={`${props.photoBase}/${m.message_id}`}>届いた写真を見る</a> : null}
  </section>)}</div>;
}
export async function photoResponse(c: Context<AppEnv>, contact: Contact, messageId: string) {
  if (contact.closed_at && Date.parse(contact.closed_at) + 30 * 86400_000 <= Date.now()) return c.notFound();
  const message = (await messages(c.env.DB, contact.contact_id)).find((m) => m.message_id === messageId);
  if (!message?.photo_key) return c.notFound();
  const photo = await new WardBucket(c.env.ORIGINALS, CONTACT_WARD).get(message.photo_key);
  if (!photo) return c.notFound();
  c.header("Content-Type", message.photo_type ?? "application/octet-stream");
  c.header("Content-Disposition", "inline");
  return c.body(photo.body);
}
export const contactRoutes = new Hono<AppEnv>();
contactRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store"); c.header("X-Robots-Tag", "noindex"); c.header("Referrer-Policy", "no-referrer");
  await next();
});
contactRoutes.use("*", csrf());
contactRoutes.use("*", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.html(<ContactError message="写真が大きすぎます。7MBまでの写真にして送ってください。" href={c.req.path} />, 413) }));
contactRoutes.get("/", (c) => c.html(<ContactPage title="SasaeAIへの問い合わせ">
  <h1>SasaeAIへの問い合わせ</h1><p class="lead">役員の方が使ってください。住民の方は、区の役員へ聞いてください。</p>
  <form method="post" action="/contact"><fieldset><legend>何にお困りですか</legend><div class="choice">
    {Object.entries(KINDS).map(([kind, label]) => <label><input type="radio" name="kind" value={kind} required checked={kind === "access"} />{label}</label>)}
  </div></fieldset>
    <label for="contact-ward">区の名前</label><input id="contact-ward" name="wardName" maxlength={60} value={c.req.query("ward")?.slice(0, 60) ?? ""} />
    <label for="contact-name">お名前</label><input id="contact-name" name="name" required maxlength={60} autocomplete="name" />
    <label for="contact-reach">メールアドレス</label><input id="contact-reach" name="reach" type="email" required maxlength={200} autocomplete="email" />
    <p>受付番号と、やりとりの画面のリンクを送ります。今使えるメールアドレスを書いてください。登録したものと違っても、家族のメールでもかまいません。</p>
    <label for="contact-body">くわしく</label><textarea id="contact-body" name="body" required maxlength={5000} rows={6} />
    <Turnstile sitekey={sitekey(c.env)} /><div class="action-bar"><button>送る</button></div>
  </form><a class="quiet" href="/">最初の画面へ戻る</a>
</ContactPage>));
contactRoutes.post("/", async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => typeof form[key] === "string" ? form[key].trim() : "";
  const kind = text("kind"), name = text("name"), wardName = text("wardName"), reach = text("reach"), body = text("body");
  if (!Object.hasOwn(KINDS, kind) || !name || name.length > 60 || wardName.length > 60 || (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reach) || reach.length > 200) || !body || body.length > 5000) {
    return c.html(<ContactError message="お名前と、使えるメールアドレス、くわしい内容を入れてください。" />, 400);
  }
  if (!await allowSend(c.env.DB, `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`)
    || (reach && !await allowSend(c.env.DB, `reach:${reach.toLowerCase()}`, 3600, 3))) {
    return c.html(<ContactError message="続けて送られたため、受け付けていません。時間をおいてもう一度送ってください。" />, 429);
  }
  if (!await verified(c, form)) return c.html(<ContactError message="送信の確認ができませんでした。もう一度画面を開いて送ってください。" />, 403);
  const received = await receiveContact(c.env.DB, { kind: kind as ContactKind, name, wardName, reach, body });
  const href = `/contact/${received.token}`;
  const mailed = await mailNotice(c.env, { reach, receipt: received.receipt }, new URL(href, c.req.url).href);
  return c.html(<ContactPage title="問い合わせを受け取りました"><h1>問い合わせを受け取りました</h1>
    <Notice>受付番号{receiptLabel(received.receipt)}</Notice>
    <p>{mailed === "sent" ? "受付番号と、やりとりの画面のリンクをメールで送りました。迷惑メールのフォルダも見てください。"
      : "メールをまだ送れないため、この画面を閉じないでください。返事は、下のやりとりの画面で読めます。"}</p>
    {mailed === "failed" ? <Notice error>問い合わせは受け付けましたが、メールを送れませんでした。</Notice> : null}
    <p>受付番号からは、やりとりの画面を開き直せません。</p>
    <section class="next"><strong>次は</strong><p>やりとりの画面を開いて、返事を見てください。</p><a class="button contact-thread-link" href={href}>やりとりの画面を開く</a></section>
    <a class="quiet" href="/contact">問い合わせのフォームへ戻る</a>
  </ContactPage>, 201);
});
contactRoutes.get("/:token", async (c) => {
  const contact = await contactByToken(c.env.DB, c.req.param("token"));
  if (!contact) return c.html(<ContactPage title="見つかりません"><h1>見つかりません</h1><p>受け付けたときのリンクを確かめてください。</p><a class="quiet" href="/contact">問い合わせのフォームへ戻る</a></ContactPage>, 404);
  let invitation: string | null = null;
  if (contact.grant_id && contact.target_ward_id && contact.grant_expires_at! > new Date().toISOString()) {
    const active = await c.env.DB.prepare("SELECT token_hash FROM sign_in_links WHERE ward_id = ? AND link_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .bind(contact.target_ward_id, contact.grant_id, new Date().toISOString()).first<{ token_hash: string }>();
    if (active) {
      const ward = await c.env.DB.prepare("SELECT slug FROM wards WHERE ward_id = ?").bind(contact.target_ward_id).first<{ slug: string }>();
      const token = await contactInvitationToken(c.env, contact.contact_id, contact.grant_id);
      if (ward && active.token_hash === await sha256Hex(token)) invitation = new URL(`/${encodeURIComponent(ward.slug)}/admin/invite/${token}`, c.req.url).href;
    }
  }
  const href = c.req.path;
  return c.html(<ContactPage title="問い合わせのやりとり"><h1>問い合わせのやりとり</h1><p class="lead">受付番号{receiptLabel(contact.receipt)} {contact.closed_at ? "受付は閉じています" : "返事をここで読めます"}</p>
    {c.req.query("sent") === "1" ? <Notice>書き足した内容を送りました。下のボタンで返事を確かめられます。</Notice> : null}
    {!contactBindings(c.env).CONTACT_MAIL ? <Notice>メールをまだ送れないため、この画面を閉じないでください。「返事を確かめる」で返事を読めます。</Notice> : null}
    <Conversation contact={contact} entries={await messages(c.env.DB, contact.contact_id)} photoBase={`${href}/photos`} />
    {invitation ? <section class="next"><strong>本人と確かめました</strong><p>入り方を選んでください。一度だけ、24時間使えます。</p><a class="button" href={invitation}>入り方を選ぶ</a></section> : null}
    <a class="button secondary" href={href}>返事を確かめる</a>
    {!contact.closed_at ? <form method="post" action={href} enctype="multipart/form-data">
      <label for="more">書き足す</label><textarea id="more" name="body" maxlength={5000} rows={5} />
      <label for="photo">写真を送る</label><input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" />
      <p>写真は頼まれたときに送ってください。受付を閉じて30日で消えます。</p>
      <Turnstile sitekey={sitekey(c.env)} /><div class="action-bar"><button>送る</button></div>
    </form> : <p>この問い合わせの対応は終わりました。</p>}
    <a class="quiet" href="/contact">問い合わせのフォームへ戻る</a>
  </ContactPage>);
});
contactRoutes.post("/:token", async (c) => {
  const contact = await contactByToken(c.env.DB, c.req.param("token"));
  if (!contact || contact.closed_at) return c.html(<ContactError message="この受付には書き足せません。" href={c.req.path} />, 400);
  const form = await c.req.parseBody();
  const body = typeof form.body === "string" ? form.body.trim() : "";
  const photo = form.photo instanceof File && form.photo.size > 0 ? form.photo : undefined;
  if ((!body && !photo) || body.length > 5000 || (photo && (photo.size > 7 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(photo.type)))) {
    return c.html(<ContactError message="書き足す内容か、7MBまでの写真を入れてください。" href={c.req.path} />, 400);
  }
  if (!await allowSend(c.env.DB, `thread:${contact.contact_id}`)) return c.html(<ContactError message="続けて送られたため、送っていません。10分ほどおいてください。" href={c.req.path} />, 429);
  if (!await verified(c, form)) return c.html(<ContactError message="送信の確認ができませんでした。もう一度画面を開いてください。" href={c.req.path} />, 403);
  await appendMessage(c.env, contact, "person", body, photo);
  return c.redirect(`${c.req.path}?sent=1`, 303);
});
contactRoutes.get("/:token/photos/:messageId", async (c) => {
  const contact = await contactByToken(c.env.DB, c.req.param("token"));
  return contact ? photoResponse(c, contact, c.req.param("messageId")) : c.notFound();
});
