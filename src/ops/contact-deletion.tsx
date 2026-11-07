import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Hint, Layout, Notice } from "../core/ui";
import { formatJst } from "../core/time";
import { CONTACT_WARD, KINDS, type Contact } from "../contact/store";
import { receiptLabel } from "../contact/pages";
import { deleteContact } from "../contact/delete";

// /opsの認証と、フォームの送信元の検査の内側へ接続する。
export const contactDeletionRoutes = new Hono<AppEnv>();
contactDeletionRoutes.get("/", async (c) => {
  const contacts = await c.env.DB.prepare(`SELECT contact_id, receipt, kind, ward_name, name, created_at
    FROM provider_contacts WHERE ward_id = ? ORDER BY created_at DESC`)
    .bind(CONTACT_WARD).all<Pick<Contact, "contact_id" | "receipt" | "kind" | "ward_name" | "name" | "created_at">>();
  return c.html(<Layout title="問い合わせを消す" siteName="SasaeAI 運用の画面" noindex>
    <h1>問い合わせを消す</h1><p class="lead">提供側が、消してほしいと頼まれた受付を選んで消します。</p>
    <Hint text="名前、メールアドレス、本文、本人を確かめた内容、添付写真が消え、やりとりの画面は開けなくなります。使っていない入るためのリンクも使えなくなります。元には戻せません。以前の日次の写しは残るため、提供側が手順書に従って別に対応します。" />
    {contacts.results.length ? contacts.results.map((contact) => <section class="panel">
      <h2>受付{receiptLabel(contact.receipt)}</h2><p>{contact.ward_name} {contact.name} {KINDS[contact.kind]}</p><p>{formatJst(contact.created_at)}</p>
      <a class="button secondary" href={`/ops/contacts/${contact.contact_id}`}>やりとりを見る</a>
      <form method="post" action={`/ops/contact-deletions/${contact.contact_id}`}><button class="secondary">この受付と写真を消す</button></form>
    </section>) : <p>受付はありません。</p>}
    <a class="quiet" href="/ops/contacts">問い合わせの一覧へ戻る</a><a class="quiet" href="/ops/">区の一覧へ戻る</a>
  </Layout>);
});
contactDeletionRoutes.post("/:id", async (c) => {
  let result: Awaited<ReturnType<typeof deleteContact>>;
  try {
    result = await deleteContact(c.env, c.req.param("id"));
  } catch {
    return c.html(<Layout title="受付を消し終えていません" noindex><h1>受付を消し終えていません</h1>
      <Notice error>消去を完了できませんでした。提供側で保存先の状態を確かめてから、同じ受付の「この受付と写真を消す」を押してください。途中まで進んだ受付は閉じた状態で残ります。</Notice>
      <a class="button" href="/ops/contact-deletions">消す受付の一覧へ戻る</a></Layout>, 503);
  }
  const title = result === "busy" ? "入るためのリンクを作っています" : result === "missing" ? "その受付はありません" : "今の受付と写真を消しました";
  return c.html(<Layout title={title} siteName="SasaeAI 運用の画面" noindex><h1>{title}</h1>
    <Notice>{result === "busy" ? "少し待ってから、もう一度同じ受付を消してください。" : result === "missing" ? "すでに消した受付か、アドレスが違うようです。" : "名前、メールアドレス、本文、本人を確かめた内容と添付写真を消しました。以前の日次の写しは残っています。提供側が手順書の対応を終えるまで、すべて消したとは案内しないでください。"}</Notice>
    <section class="next"><strong>次は</strong><p>ほかの受付を見るか、区の一覧に戻れます。</p><a class="button" href="/ops/contact-deletions">消す受付の一覧へ戻る</a></section>
    <a class="quiet" href="/ops/">区の一覧へ戻る</a></Layout>, result === "busy" ? 409 : result === "missing" ? 404 : 200);
});
