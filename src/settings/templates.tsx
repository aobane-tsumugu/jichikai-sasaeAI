import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { newId } from "../core/ids";
import { cleanName } from "../core/password";
import { Hint, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { LIMITS, SETTING_KEYS } from "./keys";
import { deleteSetting, getTemplates, saveTemplates } from "./store";

// 定型文（雨天の変更の知らせなど）。会場や日時を入れて、すぐ出せる文の型。

export const templates = new Hono<AdminEnv>();

const DONE: Record<string, string> = {
  saved: "保存しました。",
  removed: "決まった知らせの文を消しました。",
  reset: "標準の決まった知らせの文に戻しました。",
};

const base = (c: Context<AdminEnv>, rest = "") => adminPath(c.var.ward, `/settings/templates${rest}`);

type SubmittedTemplate = { id?: string; name: string; body: string };

function submittedTemplate(form: Record<string, unknown>, id?: string): SubmittedTemplate {
  return { id, name: typeof form.name === "string" ? form.name : "", body: typeof form.body === "string" ? form.body : "" };
}

async function show(c: Context<AdminEnv>, extra: { notice?: string; error?: string; retry?: SubmittedTemplate } = {}, status: 200 | 400 | 404 = 200) {
  const { ward, account } = c.var;
  const list = await getTemplates(c.env.DB, ward.wardId);
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="決まった知らせの文" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
      <h1>決まった知らせの文</h1><p class="lead">雨の変更など、繰り返し使う知らせの文を用意する画面です。直したい文の名前と本文を書き換えてください。</p>
      <p class="muted">
        {"{会場}"} のように波括弧で囲んだ言葉は、知らせを出すときに会場や日時などの中身に置き換わります。
      </p>
      {extra.notice ? <Notice>{extra.notice}</Notice> : null}
      {extra.error ? <Notice error>{extra.error}{extra.retry ? " 入れた内容は残っています。" : ""}</Notice> : null}
      {list.map((t) => (
        <form method="post" action={base(c, `/${t.id}`)} class="panel">
          <label for={`name-${t.id}`}>名前</label>
          <input id={`name-${t.id}`} name="name" type="text" required maxlength={LIMITS.templateName} value={extra.retry?.id === t.id ? extra.retry.name : t.name} />
          <label for={`body-${t.id}`}>本文</label>
          <textarea id={`body-${t.id}`} name="body" rows={5} required maxlength={LIMITS.templateBody}>
            {extra.retry?.id === t.id ? extra.retry.body : t.body}
          </textarea>
          <div class="action-links">
            <button type="submit" class="secondary">保存する</button>{" "}
            <button
              type="submit"
              class="secondary danger"
              formaction={base(c, `/${t.id}/remove`)}
              formnovalidate
              onclick="return confirm('この決まった知らせの文を消します。')"
            >
              消す
            </button>
          </div>
        </form>
      ))}
      <form method="post" action={base(c)} class="panel">
        <label for="new-name">決まった知らせの文を足す（名前）</label>
        <input id="new-name" name="name" type="text" required maxlength={LIMITS.templateName} value={extra.retry?.id === undefined ? extra.retry?.name ?? "" : ""} />
        <label for="new-body">本文</label>
        <textarea id="new-body" name="body" rows={5} required maxlength={LIMITS.templateBody}>{extra.retry?.id === undefined ? extra.retry?.body ?? "" : ""}</textarea>
        <p class="action-bar page-action">
          <button type="submit">足す</button>
        </p>
      </form>
      <form method="post" action={base(c, "/reset")} onsubmit="return confirm('保存した決まった知らせの文を全部消して、標準の決まった知らせの文に戻します。')">
        <button type="submit" class="secondary">
          標準の決まった知らせの文に戻す
        </button> <Hint text="保存した決まった知らせの文をすべて消して、初めから用意された決まった知らせの文に戻します。" />
      </form>
    </AdminPage>,
    status,
  );
}

templates.get("/", (c) => {
  const code = c.req.query("done");
  if (!code || !(code in DONE)) return show(c);
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="保存しました" back={{ href: adminPath(c.var.ward, "/settings"), label: "区の設定へ" }}>
    <h1>保存しました</h1><div class="notice done"><strong>{DONE[code]}</strong><p>次に知らせを作るときから、この内容で使えます。</p></div>
    <section class="next"><strong>次は</strong><p>ほかに直すものがなければ、最初の画面へ戻ってください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
    <h2>間違えたときは</h2><p>もう一度、区の設定から開いて直し、保存してください。すでに配った案内は変わりません。</p><a class="quiet" href={base(c)}>決まった知らせの文を直す</a>
  </AdminPage>);
});

function readFields(form: Record<string, unknown>): { name: string; body: string } | { error: string } {
  const name = cleanName(typeof form["name"] === "string" ? form["name"] : "");
  const body = (typeof form["body"] === "string" ? form["body"] : "").replace(/\r\n?/g, "\n").trim();
  if (name === "" || body === "") return { error: "名前と本文を入れてください。" };
  if (name.length > LIMITS.templateName) return { error: `名前は${LIMITS.templateName}文字までです。` };
  if (body.length > LIMITS.templateBody) return { error: `本文は${LIMITS.templateBody}文字までです。` };
  return { name, body };
}

templates.post("/", async (c) => {
  const form = await c.req.parseBody();
  const fields = readFields(form);
  if ("error" in fields) return show(c, { error: fields.error, retry: submittedTemplate(form) }, 400);
  const list = await getTemplates(c.env.DB, c.var.ward.wardId);
  if (list.length >= LIMITS.templateCount) return show(c, { error: `決まった知らせの文は${LIMITS.templateCount}個までです。`, retry: submittedTemplate(form) }, 400);
  list.push({ id: `t${newId().slice(0, 8)}`, ...fields });
  await saveTemplates(c.env.DB, c.var.ward.wardId, list, c.var.account.accountId);
  return c.redirect(base(c, "?done=saved"), 303);
});

templates.post("/reset", async (c) => {
  await deleteSetting(c.env.DB, c.var.ward.wardId, SETTING_KEYS.templates);
  return c.redirect(base(c, "?done=reset"), 303);
});

templates.post("/:id", async (c) => {
  const form = await c.req.parseBody();
  const fields = readFields(form);
  if ("error" in fields) return show(c, { error: fields.error, retry: submittedTemplate(form, c.req.param("id")) }, 400);
  const list = await getTemplates(c.env.DB, c.var.ward.wardId);
  const target = list.find((t) => t.id === c.req.param("id"));
  if (!target) return show(c, { error: "その決まった知らせの文は見つかりません。" }, 404);
  Object.assign(target, fields);
  await saveTemplates(c.env.DB, c.var.ward.wardId, list, c.var.account.accountId);
  return c.redirect(base(c, "?done=saved"), 303);
});

templates.post("/:id/remove", async (c) => {
  const list = await getTemplates(c.env.DB, c.var.ward.wardId);
  const kept = list.filter((t) => t.id !== c.req.param("id"));
  if (kept.length === list.length) return show(c, { error: "その決まった知らせの文は見つかりません。" }, 404);
  await saveTemplates(c.env.DB, c.var.ward.wardId, kept, c.var.account.accountId);
  return c.redirect(base(c, "?done=removed"), 303);
});
