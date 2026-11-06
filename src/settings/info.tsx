import { DigestFields, getDigestSettings, saveDigestSettings } from "./digest";
import { AnswerLabelFields, getAnswerLabels, saveAnswerLabels } from "./answer-labels";
import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { LIMITS, PUBLIC_PRIVACY_NOTICE, SETTING_KEYS, linesToList } from "./keys";
import { deleteSetting, getPublicContact, getSquads, setSetting } from "./store";

// 区の情報: 公開用の連絡先、班の名前、答えの聞き方、知らせの時刻。公式LINEは提供側が開設時に用意する。

export const info = new Hono<AdminEnv>();

async function show(c: Context<AdminEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 400 = 200, form?: { contact: string; squads: string }) {
  const { ward, account } = c.var;
  const contact = form?.contact ?? (await getPublicContact(c.env.DB, ward.wardId));
  const squads = form?.squads ?? (await getSquads(c.env.DB, ward.wardId)).join("\n");
  const digest = await getDigestSettings(c.env.DB, ward.wardId);
  const labels = await getAnswerLabels(c.env.DB, ward.wardId);
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="区の情報" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
      <h1>区の情報</h1><p class="lead">案内と区のページに出る内容です。ふだんは直さなくてかまいません。</p>
      {extra.notice ? <Notice>{extra.notice}</Notice> : null}
      {extra.error ? <Notice error>{extra.error}</Notice> : null}
      <form method="post" action={adminPath(ward, "/settings/info")}>
        <h2>区のページで伝えること</h2>
        <p class="panel">{PUBLIC_PRIVACY_NOTICE}</p>
        <p class="muted">利用目的、委託先、消し方はこの文で案内します。消す希望は公開用の連絡先から受け付けます。</p>
        <label for="contact">公開用の連絡先</label>
        <p class="muted">区のページに載ります。役員個人の電話番号やメールは書かず、自治会の窓口にしてください。</p>
        <textarea id="contact" name="contact" rows={4} maxlength={LIMITS.publicContact}>
          {contact}
        </textarea>
        <label for="squads">班の名前（一行に一つ）</label>
        <p class="muted">回答票に印字され、答える画面の選択肢になります。名簿を入れると、そこから入ります。</p>
        <textarea id="squads" name="squads" rows={8}>
          {squads}
        </textarea>
        <AnswerLabelFields labels={labels} />
        <DigestFields value={digest} />
        <div class="action-bar"><button type="submit">保存する</button></div>
      </form>
    </AdminPage>,
    status,
  );
}

info.get("/", (c) => {
  if (c.req.query("done") !== "1") return show(c);
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="保存しました" back={{ href: adminPath(c.var.ward, "/settings"), label: "区の設定へ" }}>
    <h1>保存しました</h1><div class="notice done"><strong>保存しました</strong><p>次に配る案内と、これから送る問い合わせの知らせに使います。</p></div>
    <section class="next"><strong>次は</strong><p>ほかに直すものがなければ、最初の画面へ戻ってください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
    <h2>間違えたときは</h2><p>もう一度、区の設定から開いて直し、保存してください。すでに配った案内は変わりません。</p><a class="quiet" href={adminPath(c.var.ward, "/settings/info")}>区の情報を直す</a>
  </AdminPage>);
});

info.post("/", async (c) => {
  const { ward, account } = c.var;
  const body = await c.req.parseBody();
  const contact = typeof body["contact"] === "string" ? body["contact"].replace(/\r\n?/g, "\n").trim() : "";
  const squadText = typeof body["squads"] === "string" ? body["squads"] : "";
  const squads = linesToList(squadText);

  if (contact.length > LIMITS.publicContact) {
    return show(c, { error: `公開用の連絡先は${LIMITS.publicContact}文字までです。` }, 400, { contact, squads: squadText });
  }
  if (squads.length > LIMITS.squadCount || squads.some((s) => s.length > LIMITS.squadName)) {
    return show(
      c,
      { error: `班の名前は${LIMITS.squadCount}個まで、一つ${LIMITS.squadName}文字までです。` },
      400,
      { contact, squads: squadText },
    );
  }

  if (typeof body.answer_label_0 === "string" || body.answer_labels_reset === "1") {
    if (!await saveAnswerLabels(c.env.DB, ward.wardId, body, account.accountId)) return show(c, { error: "人数の聞き方を三つとも入れてください。一つ80文字までです。" }, 400, { contact, squads: squadText });
  }
  if (!await saveDigestSettings(c.env.DB, ward.wardId, body, account.accountId)) return show(c, { error: "知らせの時刻と日数を確かめてください。日数は0から365までです。" }, 400, { contact, squads: squadText });
  if (contact === "") await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact, contact, account.accountId);
  if (squads.length === 0) await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads, JSON.stringify(squads), account.accountId);
  return c.redirect(adminPath(ward, "/settings/info?done=1"), 303);
});
