import { AnswerLabelFields, getAnswerLabels, saveAnswerLabels } from "./answer-labels";
import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { LIMITS, PUBLIC_PRIVACY_NOTICE, SETTING_KEYS, linesToList } from "./keys";
import { deleteSetting, getOfficialLineUrl, getPublicContact, getSquads, setSetting } from "./store";

// 区の情報: 公開用の連絡先、公式 LINE の友だち追加の入口、班の名前。いずれも任意。

export const info = new Hono<AdminEnv>();

async function show(c: Context<AdminEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 400 = 200, form?: { contact: string; squads: string; lineUrl: string }) {
  const { ward, account } = c.var;
  const contact = form?.contact ?? (await getPublicContact(c.env.DB, ward.wardId));
  const squads = form?.squads ?? (await getSquads(c.env.DB, ward.wardId)).join("\n");
  const lineUrl = form?.lineUrl ?? (await getOfficialLineUrl(c.env.DB, ward.wardId));
  const labels = await getAnswerLabels(c.env.DB, ward.wardId);
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="区の情報" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
      <h1>区の情報</h1><p class="lead">区のページで使う連絡先、公式LINEの友だち追加の入口、班の名前を設定します。どれも書かなくてかまいません。</p>
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
        <label for="official-line-url">公式LINEの友だち追加のURL（書かなくてかまいません） </label><p class="help-text">公式LINEの管理画面で確認できる、友だち追加のURLを貼ってください。区のページに入口が出ます。空にして保存すると入口を外せます。</p>
        <input id="official-line-url" name="official_line_url" type="url" value={lineUrl} />
        <p class="muted">友だち追加は、しなくてもかまいません。住民に名前や世帯の登録を求めません。</p>
        <label for="squads">班の名前（一行に一つ）</label>
        <p class="muted">回答票に印字され、答えの入口で選ぶ一覧になります。名簿を入れると、そこから入ります。</p>
        <textarea id="squads" name="squads" rows={8}>
          {squads}
        </textarea>
        <AnswerLabelFields labels={labels} />
        <div class="action-bar"><button type="submit">保存する</button></div>
      </form>
    </AdminPage>,
    status,
  );
}

info.get("/", (c) => {
  if (c.req.query("done") !== "1") return show(c);
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="保存しました" back={{ href: adminPath(c.var.ward, "/settings"), label: "区の設定へ" }}>
    <h1>保存しました</h1><div class="notice done"><strong>保存しました</strong><p>次に配る案内から、この内容で出ます。</p></div>
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
  const lineUrl = typeof body["official_line_url"] === "string" ? body["official_line_url"].trim() : "";
  if (lineUrl) {
    try {
      if (new URL(lineUrl).protocol !== "https:") throw new Error("https");
    } catch {
      return show(c, { error: "友だち追加のURLはhttps:// で始まるURLを入れてください。" }, 400, { contact, squads: squadText, lineUrl });
    }
  }

  if (contact.length > LIMITS.publicContact) {
    return show(c, { error: `公開用の連絡先は${LIMITS.publicContact}文字までです。` }, 400, { contact, squads: squadText, lineUrl });
  }
  if (squads.length > LIMITS.squadCount || squads.some((s) => s.length > LIMITS.squadName)) {
    return show(
      c,
      { error: `班の名前は${LIMITS.squadCount}個まで、一つ${LIMITS.squadName}文字までです。` },
      400,
      { contact, squads: squadText, lineUrl },
    );
  }

  if (typeof body.answer_label_0 === "string" || body.answer_labels_reset === "1") {
    if (!await saveAnswerLabels(c.env.DB, ward.wardId, body, account.accountId)) return show(c, { error: "人数の聞き方を三つとも入れてください。一つ80文字までです。" }, 400, { contact, squads: squadText, lineUrl });
  }
  if (contact === "") await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact, contact, account.accountId);
  if (squads.length === 0) await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads, JSON.stringify(squads), account.accountId);
  if (lineUrl === "") await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.officialLineUrl);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.officialLineUrl, lineUrl, account.accountId);
  return c.redirect(adminPath(ward, "/settings/info?done=1"), 303);
});
