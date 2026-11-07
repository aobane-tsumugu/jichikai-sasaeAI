import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { Notice } from "../core/ui";
import { nowIso } from "../core/ids";
import { formatJst } from "../core/time";
import { listAccounts } from "../settings/accounts";
import { listWards } from "./wards";
import { ContactError, ContactPage, Conversation, mailNotice, photoResponse, receiptLabel } from "../contact/pages";
import { appendMessage, CONTACT_WARD, contactById, KINDS, messages, type Contact } from "../contact/store";
import { issueContactInvitation } from "../contact/invitation";

export const contactOpsRoutes = new Hono<AppEnv>();
function missing(c: Context<AppEnv>) {
  return c.html(<ContactPage title="見つかりません" ops><h1>その受付は見つかりません</h1><p>問い合わせの一覧から開いてください。</p></ContactPage>, 404);
}
const contactPath = (contact: Contact) => `/ops/contacts/${contact.contact_id}`;
function done(c: Context<AppEnv>, contact: Contact, title: string, detail: string) {
  return c.html(<ContactPage title={title} ops><h1>{title}</h1><Notice>{detail}</Notice>
    <section class="next"><strong>次は</strong><p>{contact.kind === "access" ? "やりとりの画面で対応を続けられます。本人がログインできたことを確かめたら受付を閉じてください。" : "やりとりの画面で対応を続けられます。返事が伝わり、対応が終わったら受付を閉じてください。"}</p><a class="button" href={contactPath(contact)}>受付に戻る</a></section>
    <a class="quiet" href="/ops/contacts">問い合わせの一覧へ戻る</a></ContactPage>);
}
contactOpsRoutes.get("/", async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM provider_contacts WHERE ward_id = ? ORDER BY created_at DESC")
    .bind(CONTACT_WARD).all<Contact>();
  const rows = (closed: boolean) => result.results.filter((r) => !!r.closed_at === closed).map((r) => <a class="row-link" href={contactPath(r)}>
    <b>受付{receiptLabel(r.receipt)} {r.ward_name} {r.name}</b><span>{KINDS[r.kind]}</span><span>{r.closed_at ? `${formatJst(r.closed_at)}に閉じました` : r.verified_at ? "本人と確かめました" : "対応中"}</span>
  </a>);
  return c.html(<ContactPage title="問い合わせの一覧" ops><h1>問い合わせの一覧</h1><p class="lead">フォームから届いたものです。入れないという問い合わせは、本人を確かめてからリンクを出します。</p>
    {result.results.some((r) => !r.closed_at) ? rows(false) : <p>開いている受付はありません。フォームから届くとここに出ます。</p>}
    <h2>終わったもの</h2>{rows(true)}<a class="quiet" href="/ops/">自治会の一覧へ戻る</a>
  </ContactPage>);
});
contactOpsRoutes.get("/:id", async (c) => {
  const contact = await contactById(c.env.DB, c.req.param("id"));
  if (!contact) return missing(c);
  const path = contactPath(contact);
  const wards = await listWards(c.env.DB);
  const selected = wards.find((w) => w.wardId === c.req.query("wardId"));
  const accounts = selected ? await listAccounts(c.env.DB, selected.wardId) : [];
  const privateContact = selected ? await c.env.DB.prepare("SELECT phone, email FROM provider_ward_contacts WHERE ward_id = ?")
    .bind(selected.wardId).first<{ phone: string; email: string }>() : null;
  return c.html(<ContactPage title={`受付${receiptLabel(contact.receipt)}`} ops>
    <h1>受付{receiptLabel(contact.receipt)} {KINDS[contact.kind]}</h1>
    <dl class="facts long"><dt>書かれた自治会</dt><dd>{contact.ward_name || "書かれていません"}</dd><dt>名乗った名前</dt><dd>{contact.name}</dd>
      <dt>届いた日</dt><dd>{formatJst(contact.created_at)}</dd><dt>メールアドレス</dt><dd>{contact.reach}</dd></dl>
    <p>連絡は、フォームに書かれた連絡先へしてください。書かれた自治会と名前は、確かめるときの参考です。</p>
    <Conversation contact={contact} entries={await messages(c.env.DB, contact.contact_id)} photoBase={`${path}/photos`} />
    <p class="muted">写真は、受付を閉じて30日で消えます。</p>
    {contact.closed_at ? <Notice>この受付は{formatJst(contact.closed_at)}に閉じました。</Notice> : <>
      <h2>返事を書く</h2><form method="post" action={`${path}/reply`}>
        <label for="reply">返事</label><textarea id="reply" name="body" required maxlength={5000} rows={5} />
        <p>やりとりの画面に出ます。メールで、返事を書いたことを知らせます。送れないときも、やりとりの画面で読めます。</p>
        <button>返事を送る</button>
      </form>
      {contact.kind === "access" && !contact.grant_id ? <section><h2>ログインするためのリンクを出す</h2>
        <p>書かれた連絡先だけでは本人か分からないので、別の道で一つ確かめてから出します。ほかの役員に頼めるかも聞いてください。</p>
        <form method="get" action={path}><label for="wardId">自治会</label><select id="wardId" name="wardId" required>
          <option value="">自治会を選んでください</option>{wards.map((w) => <option value={w.wardId} selected={selected?.wardId === w.wardId}>{w.name}</option>)}
        </select><button class="secondary">この自治会の画面を使える人を見る</button></form>
        {selected ? <><dl class="facts long"><dt>自治会の連絡先の電話</dt><dd>{privateContact?.phone || "まだ聞いていません"}</dd><dt>自治会の連絡先のメール</dt><dd>{privateContact?.email || "まだ聞いていません"}</dd></dl>
          <p>自治会の連絡先は、本人を確かめる手がかりです。問い合わせへの連絡先とは別です。</p>
          <form method="post" action={`${path}/invite`}>
            <input type="hidden" name="wardId" value={selected.wardId} /><fieldset><legend>だれのリンクか</legend><div class="choice">
              {accounts.map((a) => <label><input type="radio" name="accountId" value={a.accountId} required />{a.name}</label>)}
              <label><input type="radio" name="accountId" value="new" required />新しい人を足す</label>
            </div></fieldset>
            <label for="newName">足す人の名前（新しい人を足すときだけ）</label><input id="newName" name="newName" maxlength={40} />
            <label for="how">どう確かめたか</label><input id="how" name="how" required maxlength={1000} />
            <p>例: 自治会の連絡先の人へ電話した。全員が交代したときは、総会の資料と別の人への電話で確かめます。</p>
            <p>前のリンクとパスワードは使えなくなります。LINEとメールのつなぎ、覚えたスマホやパソコンはそのままです。新しいリンクは一度だけ、24時間使えます。</p>
            <button>確かめたので、リンクを出す</button>
          </form></> : null}
      </section> : null}
      {contact.verified_at ? <section><h2>本人と確かめた記録</h2><dl class="facts long">
        <dt>どう確かめたか</dt><dd>{contact.verified_how}</dd>
        <dt>連絡した先</dt><dd>{contact.reach || "やりとりの画面"}</dd><dt>した人</dt><dd>{contact.verified_by}</dd><dt>した日</dt><dd>{formatJst(contact.verified_at)}</dd></dl>
        <p>リンクをやりとりの画面に出しました。「この画面を使える人」にも記録が残ります。</p>
      </section> : null}
      <h2>受付を閉じる</h2><p>対応が終わったときに閉じます。どの問い合わせでもここから閉じられます。</p>
      <form method="post" action={`${path}/close`}><button class="secondary">受付を閉じる</button></form>
    </>}
    <a class="quiet" href="/ops/contacts">問い合わせの一覧へ戻る</a>
  </ContactPage>);
});
contactOpsRoutes.post("/:id/reply", async (c) => {
  const contact = await contactById(c.env.DB, c.req.param("id"));
  if (!contact) return missing(c);
  const form = await c.req.parseBody();
  const body = typeof form.body === "string" ? form.body.trim() : "";
  if (contact.closed_at || !body || body.length > 5000) return c.html(<ContactError message="開いている受付で、返事を5000文字までで書いてください。" href={contactPath(contact)} ops />, 400);
  await appendMessage(c.env, contact, "provider", body);
  const sent = await mailNotice(c.env, contact);
  return done(c, contact, "返事を残しました", sent === "sent" ? "やりとりの画面に返事を残し、書かれたメールへ知らせました。" : "やりとりの画面に返事を残しました。メールは送っていません。問い合わせた方は、やりとりの画面で返事を読めます。");
});
contactOpsRoutes.post("/:id/invite", async (c) => {
  const contact = await contactById(c.env.DB, c.req.param("id"));
  if (!contact) return missing(c);
  const form = await c.req.parseBody();
  const text = (key: string) => typeof form[key] === "string" ? form[key].trim() : "";
  const result = await issueContactInvitation(c.env, contact.contact_id, { wardId: text("wardId"), accountId: text("accountId"), newName: text("newName"), how: text("how"), origin: c.req.url });
  if (!result.ok) return c.html(<ContactError message={result.message} href={contactPath(contact)} ops />, 400);
  const sent = await mailNotice(c.env, contact);
  return done(c, contact, "リンクを出しました", `${result.name}さんのやりとりの画面に、ログインするためのリンクを出しました。一度だけ、24時間使えます。${sent === "sent" ? "書かれたメールへ知らせました。" : "メールは送っていません。書かれた連絡先へ連絡してください。"}`);
});
contactOpsRoutes.post("/:id/close", async (c) => {
  const contact = await contactById(c.env.DB, c.req.param("id"));
  if (!contact) return missing(c);
  const closed = await c.env.DB.prepare(`UPDATE provider_contacts SET closed_at = COALESCE(closed_at, ?) WHERE ward_id = ? AND contact_id = ?
    AND (grant_id IS NULL OR grant_expires_at IS NOT NULL)`)
    .bind(nowIso(), CONTACT_WARD, contact.contact_id).run();
  if (!closed.meta.changes) return c.html(<ContactError message="リンクを作っています。少し待って受付を開き直してください。" href={contactPath(contact)} ops />, 409);
  return c.html(<ContactPage title="受付を閉じました" ops><h1>受付を閉じました</h1><Notice>写真は30日後に消えます。やりとりは引き続き読めます。</Notice>
    <section class="next"><strong>次は</strong><p>ほかの問い合わせを見てください。</p><a class="button" href="/ops/contacts">問い合わせの一覧へ戻る</a></section><a class="quiet" href={contactPath(contact)}>閉じた受付を見る</a></ContactPage>);
});
contactOpsRoutes.get("/:id/photos/:messageId", async (c) => {
  const contact = await contactById(c.env.DB, c.req.param("id"));
  return contact ? photoResponse(c, contact, c.req.param("messageId")) : missing(c);
});
