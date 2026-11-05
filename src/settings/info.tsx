import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Hint, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { LIMITS, PUBLIC_PRIVACY_NOTICE, SETTING_KEYS, linesToList } from "./keys";
import { deleteSetting, getPublicContact, getSquads, setSetting } from "./store";

// 区の情報: 公開用の連絡先と班の名前。班の名前は名簿の取り込み（束 5）も書く。どちらも任意。

export const info = new Hono<AdminEnv>();

async function show(c: Context<AdminEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 400 = 200, form?: { contact: string; squads: string }) {
  const { ward, account } = c.var;
  const contact = form?.contact ?? (await getPublicContact(c.env.DB, ward.wardId));
  const squads = form?.squads ?? (await getSquads(c.env.DB, ward.wardId)).join("\n");
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="区の情報" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
      <h1>区の情報 <Hint text="区のページで使う連絡先と班の名前を設定する画面です。公開する窓口の連絡先を入れてください。" /></h1>
      {extra.notice ? <Notice>{extra.notice}</Notice> : null}
      {extra.error ? <Notice error>{extra.error}</Notice> : null}
      <form method="post" action={adminPath(ward, "/settings/info")}>
        <h2>区のページで伝えること</h2>
        <p class="panel">{PUBLIC_PRIVACY_NOTICE}</p>
        <p class="muted">利用目的、委託先、消し方はこの文で案内します。消す希望は公開用の連絡先から受け付けます。</p>
        <label for="contact">公開用の連絡先</label>
        <p class="muted">区のページに載ります。役員個人の電話番号やメールは書かず、自治会の窓口にしてください。</p>
        <textarea id="contact" name="contact" rows={4} maxlength={LIMITS.publicContact} style="width:100%;font:inherit;padding:0.5rem">
          {contact}
        </textarea>
        <label for="squads">班の名前（一行に一つ）</label>
        <p class="muted">回答票に印字され、回答の入口で選ぶ一覧になります。名簿を入れると、そこから入ります。</p>
        <textarea id="squads" name="squads" rows={8} style="width:100%;font:inherit;padding:0.5rem">
          {squads}
        </textarea>
        <p>
          <button type="submit">保存する</button>
        </p>
      </form>
    </AdminPage>,
    status,
  );
}

info.get("/", (c) => show(c, c.req.query("done") === "1" ? { notice: "保存しました。" } : {}));

info.post("/", async (c) => {
  const { ward, account } = c.var;
  const body = await c.req.parseBody();
  const contact = typeof body["contact"] === "string" ? body["contact"].replace(/\r\n?/g, "\n").trim() : "";
  const squadText = typeof body["squads"] === "string" ? body["squads"] : "";
  const squads = linesToList(squadText);

  if (contact.length > LIMITS.publicContact) {
    return show(c, { error: `公開用の連絡先は ${LIMITS.publicContact} 文字までです。` }, 400, { contact, squads: squadText });
  }
  if (squads.length > LIMITS.squadCount || squads.some((s) => s.length > LIMITS.squadName)) {
    return show(
      c,
      { error: `班の名前は ${LIMITS.squadCount} 個まで、一つ ${LIMITS.squadName} 文字までです。` },
      400,
      { contact, squads: squadText },
    );
  }

  if (contact === "") await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact, contact, account.accountId);
  if (squads.length === 0) await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads, JSON.stringify(squads), account.accountId);
  return c.redirect(adminPath(ward, "/settings/info?done=1"), 303);
});
