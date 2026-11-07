import { DigestFields, digestSettingsFromForm, getDigestSettings, saveDigestSettings, timeLabel } from "./digest";
import { officerGroupId } from "../line/api";
import { AnswerLabelFields, answerLabelsFromForm, DEFAULT_ANSWER_LABELS, getAnswerLabels, saveAnswerLabels, type AnswerLabels } from "./answer-labels";
import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { LIMITS, SETTING_KEYS, linesToList } from "./keys";
import { deleteSetting, getPublicContact, getSquads, setSetting } from "./store";

// 区の情報: 公開用の連絡先、班の名前、答えの聞き方、知らせの時刻。公式LINEは提供側が開設時に用意する。

export const info = new Hono<AdminEnv>();

async function show(c: Context<AdminEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 400 = 200, form?: { contact: string; squads: string; values: Record<string, unknown> }) {
  const { ward, account } = c.var;
  const contact = form?.contact ?? (await getPublicContact(c.env.DB, ward.wardId));
  const squads = form?.squads ?? (await getSquads(c.env.DB, ward.wardId)).join("\n");
  const digest = await getDigestSettings(c.env.DB, ward.wardId);
  const savedLabels = await getAnswerLabels(c.env.DB, ward.wardId);
  const values = form?.values;
  const labels: AnswerLabels = values?.answer_labels_reset === "1" ? [...DEFAULT_ANSWER_LABELS] : [
    typeof values?.answer_label_0 === "string" ? values.answer_label_0 : savedLabels[0],
    typeof values?.answer_label_1 === "string" ? values.answer_label_1 : savedLabels[1],
    typeof values?.answer_label_2 === "string" ? values.answer_label_2 : savedLabels[2],
  ];
  const squadNames = linesToList(squads);
  const hasGroup = Boolean(await officerGroupId(c.env, ward.wardId));
  // 問い合わせの画面の文（この画面で見られます）を流用せず、この画面で、いつ何が届くかを書く。
  const when = digest.cutoff === "00:00" ? `前の日に届いた問い合わせを、毎日${timeLabel(digest.send)}に`
    : `毎日${timeLabel(digest.cutoff)}までに届いた問い合わせを、${digest.send > digest.cutoff ? "その日" : "翌日"}の${timeLabel(digest.send)}に`;
  const notify = `${hasGroup ? `${when}、役員のLINEグループへまとめて知らせます。届いていない日は送りません。`
    : "役員のLINEグループが、まだ自治会のLINEにつながっていないので、問い合わせの通知は届きません。届いた問い合わせは、最初の画面の「役員が見ないと進まないこと」に出ます。"}当日の${digest.eventDays}日前や締切の${digest.dueDays}日前からは、最初の画面に、問い合わせをときどき見る案内を出します。`;
  c.header("Cache-Control", "no-store");
  // 直せない長い文を一番上に置かず、空だと住民が困る連絡先を先に、今の状態を文で書く。
  return c.html(
    <AdminPage ward={ward} account={account} title="自治会の情報" back={{ href: adminPath(ward, "/settings"), label: "自治会の設定へ" }}>
      <h1>自治会の情報</h1>
      {extra.notice ? <Notice>{extra.notice}</Notice> : null}
      {extra.error ? <Notice error>{extra.error} 入れた内容は残っています。</Notice> : null}
      <form method="post" action={adminPath(ward, "/settings/info")}>
        <h2>住民向けのページに出す連絡先</h2>
        <p>{contact.trim() ? "住民向けのページの「連絡先」に、下の内容が出ています。住民から自分の分を消してほしいと頼まれるのも、この窓口です。"
          : "まだ入っていません。今は住民向けのページに「班長か役員へお知らせください」とだけ出ていて、班長や役員を知らない方は連絡できません。"}</p>
        <label for="contact">連絡先</label>
        <p class="muted">役員個人の電話番号やメールは書かず、自治会の窓口にしてください。</p>
        <textarea id="contact" name="contact" rows={4} maxlength={LIMITS.publicContact}>
          {contact}
        </textarea>
        <h2>班の名前</h2>
        <p>{squadNames.length ? `今は${squadNames.join("、")}の${squadNames.length}つです。紙の回答票に印字され、住民が出欠を答える画面で選べます。`
          : "まだ入っていません。入れると、紙の回答票に印字され、住民が出欠を答える画面で選べるようになります。世帯の名簿を入れると、そこからも入ります。"}</p>
        <label for="squads">班の名前（一行に一つ）</label>
        <textarea id="squads" name="squads" rows={8}>
          {squads}
        </textarea>
        <h2>問い合わせの通知</h2>
        <p>{notify}</p>
        <DigestFields value={digest} rawValues={values} open={!!extra.error} />
        <AnswerLabelFields labels={labels} open={!!extra.error} />
        <div class="action-bar"><button type="submit">保存する</button></div>
      </form>
      <h2>個人情報の扱い</h2>
      <p>住民向けのページの「個人情報の扱い」には、何に使うか、だれが預かるか、消してほしいときの頼み方を、SasaeAIの運営者が書いています。ここでは直せません。<a href={`/${ward.slug}/privacy`}>住民向けのページで読む</a></p>
    </AdminPage>,
    status,
  );
}

info.get("/", (c) => {
  if (c.req.query("done") !== "1") return show(c);
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="保存しました" back={{ href: adminPath(c.var.ward, "/settings"), label: "自治会の設定へ" }}>
    <h1>保存しました</h1><div class="notice done"><strong>保存しました</strong><p>次に知らせる案内と、これから送る問い合わせの通知に使います。</p></div>
    <section class="next"><strong>次は</strong><p>ほかに直すものがなければ、最初の画面へ戻ってください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
    <h2>間違えたときは</h2><p>もう一度、自治会の設定から開いて直し、保存してください。すでに知らせた案内は変わりません。</p><a class="quiet" href={adminPath(c.var.ward, "/settings/info")}>自治会の情報を直す</a>
  </AdminPage>);
});

info.post("/", async (c) => {
  const { ward, account } = c.var;
  const body = await c.req.parseBody();
  const contact = typeof body["contact"] === "string" ? body["contact"].replace(/\r\n?/g, "\n").trim() : "";
  const squadText = typeof body["squads"] === "string" ? body["squads"] : "";
  const squads = linesToList(squadText);
  const form = { contact, squads: squadText, values: body };

  if (contact.length > LIMITS.publicContact) {
    return show(c, { error: `公開用の連絡先は${LIMITS.publicContact}文字までです。` }, 400, form);
  }
  if (squads.length > LIMITS.squadCount || squads.some((s) => s.length > LIMITS.squadName)) {
    return show(
      c,
      { error: `班の名前は${LIMITS.squadCount}個まで、一つ${LIMITS.squadName}文字までです。` },
      400,
      form,
    );
  }

  // 入力の誤りで、一部の設定だけが変わらないよう、保存する前に既存の条件を確かめる。
  const hasLabels = typeof body.answer_label_0 === "string" || body.answer_labels_reset === "1";
  if (hasLabels && !answerLabelsFromForm(body)) return show(c, { error: "人数の聞き方を三つとも入れてください。一つ80文字までです。" }, 400, form);
  if ((body.digest_cutoff !== undefined || body.digest_send !== undefined) && !digestSettingsFromForm(body)) return show(c, { error: "通知の時刻と日数を確かめてください。日数は0から365までです。" }, 400, form);
  if (hasLabels) await saveAnswerLabels(c.env.DB, ward.wardId, body, account.accountId);
  await saveDigestSettings(c.env.DB, ward.wardId, body, account.accountId);
  if (contact === "") await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.publicContact, contact, account.accountId);
  if (squads.length === 0) await deleteSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads);
  else await setSetting(c.env.DB, ward.wardId, SETTING_KEYS.squads, JSON.stringify(squads), account.accountId);
  return c.redirect(adminPath(ward, "/settings/info?done=1"), 303);
});
