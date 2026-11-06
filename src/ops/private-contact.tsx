/** 公開の連絡先とは分け、運用の画面だけで扱う。 */
export async function getPrivateWardContact(db: D1Database, wardId: string) {
  return db.prepare("SELECT phone, email FROM provider_ward_contacts WHERE ward_id = ?")
    .bind(wardId).first<{ phone: string; email: string }>();
}
export async function savePrivateWardContact(db: D1Database, wardId: string, phone: string, email: string) {
  await db.prepare("INSERT INTO provider_ward_contacts (ward_id, phone, email) VALUES (?, ?, ?)")
    .bind(wardId, phone.trim().slice(0, 200), email.trim().slice(0, 200)).run();
}
export function PrivateWardContact(props: { value: { phone: string; email: string } | null }) {
  return <><dl class="facts long"><dt>区の連絡先の電話</dt><dd>{props.value?.phone || "まだ聞いていません"}</dd>
    <dt>区の連絡先のメール</dt><dd>{props.value?.email || "まだ聞いていません"}</dd></dl>
    <p class="muted">提供側だけが見ます。本人を確かめる手がかりの一つです。問い合わせへの連絡は、フォームに書かれた連絡先へします。</p></>;
}
