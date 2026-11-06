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
  removed: "定型文を消しました。",
  reset: "標準の定型文に戻しました。",
};

const base = (c: Context<AdminEnv>, rest = "") => adminPath(c.var.ward, `/settings/templates${rest}`);

async function show(c: Context<AdminEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 400 | 404 = 200) {
  const { ward, account } = c.var;
  const list = await getTemplates(c.env.DB, ward.wardId);
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="定型文" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
      <h1>定型文 <Hint text="雨天の変更など、繰り返し使う知らせの文を用意する画面です。直したい文の名前と本文を書き換えてください。" /></h1>
      <p class="muted">
        {"{会場}"} のように波括弧で囲んだ言葉は、知らせを出す時に会場や日時などの中身に置き換わります。
      </p>
      {extra.notice ? <Notice>{extra.notice}</Notice> : null}
      {extra.error ? <Notice error>{extra.error}</Notice> : null}
      {list.map((t) => (
        <form method="post" action={base(c, `/${t.id}`)} class="panel">
          <label for={`name-${t.id}`}>名前</label>
          <input id={`name-${t.id}`} name="name" type="text" required maxlength={LIMITS.templateName} value={t.name} />
          <label for={`body-${t.id}`}>本文</label>
          <textarea id={`body-${t.id}`} name="body" rows={5} required maxlength={LIMITS.templateBody}>
            {t.body}
          </textarea>
          <p>
            <button type="submit">保存する</button>{" "}
            <button
              type="submit"
              class="danger"
              formaction={base(c, `/${t.id}/remove`)}
              formnovalidate
              onclick="return confirm('この定型文を消します。')"
            >
              消す
            </button>
          </p>
        </form>
      ))}
      <form method="post" action={base(c)} class="panel">
        <label for="new-name">定型文を足す（名前）</label>
        <input id="new-name" name="name" type="text" required maxlength={LIMITS.templateName} />
        <label for="new-body">本文</label>
        <textarea id="new-body" name="body" rows={5} required maxlength={LIMITS.templateBody}></textarea>
        <p>
          <button type="submit">足す</button>
        </p>
      </form>
      <form method="post" action={base(c, "/reset")} onsubmit="return confirm('保存した定型文を全部消して、標準の定型文に戻します。')">
        <button type="submit" class="secondary">
          標準の定型文に戻す
        </button> <Hint text="保存した定型文をすべて消して、初めから用意された定型文に戻します。" />
      </form>
    </AdminPage>,
    status,
  );
}

templates.get("/", (c) => {
  const code = c.req.query("done");
  return show(c, code && code in DONE ? { notice: DONE[code] } : {});
});

function readFields(form: Record<string, unknown>): { name: string; body: string } | { error: string } {
  const name = cleanName(typeof form["name"] === "string" ? form["name"] : "");
  const body = (typeof form["body"] === "string" ? form["body"] : "").replace(/\r\n?/g, "\n").trim();
  if (name === "" || body === "") return { error: "名前と本文を入れてください。" };
  if (name.length > LIMITS.templateName) return { error: `名前は ${LIMITS.templateName} 文字までです。` };
  if (body.length > LIMITS.templateBody) return { error: `本文は ${LIMITS.templateBody} 文字までです。` };
  return { name, body };
}

templates.post("/", async (c) => {
  const fields = readFields(await c.req.parseBody());
  if ("error" in fields) return show(c, { error: fields.error }, 400);
  const list = await getTemplates(c.env.DB, c.var.ward.wardId);
  if (list.length >= LIMITS.templateCount) return show(c, { error: `定型文は ${LIMITS.templateCount} 個までです。` }, 400);
  list.push({ id: `t${newId().slice(0, 8)}`, ...fields });
  await saveTemplates(c.env.DB, c.var.ward.wardId, list, c.var.account.accountId);
  return c.redirect(base(c, "?done=saved"), 303);
});

templates.post("/reset", async (c) => {
  await deleteSetting(c.env.DB, c.var.ward.wardId, SETTING_KEYS.templates);
  return c.redirect(base(c, "?done=reset"), 303);
});

templates.post("/:id", async (c) => {
  const fields = readFields(await c.req.parseBody());
  if ("error" in fields) return show(c, { error: fields.error }, 400);
  const list = await getTemplates(c.env.DB, c.var.ward.wardId);
  const target = list.find((t) => t.id === c.req.param("id"));
  if (!target) return show(c, { error: "その定型文は見つかりません。" }, 404);
  Object.assign(target, fields);
  await saveTemplates(c.env.DB, c.var.ward.wardId, list, c.var.account.accountId);
  return c.redirect(base(c, "?done=saved"), 303);
});

templates.post("/:id/remove", async (c) => {
  const list = await getTemplates(c.env.DB, c.var.ward.wardId);
  const kept = list.filter((t) => t.id !== c.req.param("id"));
  if (kept.length === list.length) return show(c, { error: "その定型文は見つかりません。" }, 404);
  await saveTemplates(c.env.DB, c.var.ward.wardId, kept, c.var.account.accountId);
  return c.redirect(base(c, "?done=removed"), 303);
});
