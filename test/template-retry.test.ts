import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { getTemplates, saveTemplates } from "../src/settings/store";
import { postForm, realApp } from "./helpers";

const saved = [
  { id: "tfictional1", name: "架空の雨の知らせ", body: "架空の保存済みの雨の知らせです。" },
  { id: "tfictional2", name: "架空の延期の知らせ", body: "架空の保存済みの延期の知らせです。" },
];
const body = "架空の雨の変更のお知らせです。\n会場は{会場}へ変わります。\n来るときは日時も確かめてください。";

async function fixture() {
  const setup = await seedAdmin(env.DB);
  await saveTemplates(env.DB, setup.ward.wardId, saved, setup.account.accountId);
  return { ...setup, path: `/${setup.ward.slug}/admin/settings/templates` };
}
function form(html: string, action: string) {
  const start = html.indexOf(`action="${action}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</form>", start));
}

it("追加の名前を誤っても書いた本文を追加欄に残し、直して一件だけ保存できる", async () => {
  const f = await fixture();
  const invalid = await postForm(realApp, f.path, { name: "  ", body }, f.cookie);
  expect(invalid.status).toBe(400);
  const html = await invalid.text();
  expect(form(html, f.path)).toContain(body);
  expect(form(html, f.path)).toContain('value="  "');
  for (const template of saved) {
    const other = form(html, `${f.path}/${template.id}`);
    expect(other).toContain(template.body);
    expect(other).not.toContain(body);
  }
  expect(invalid.headers.get("cache-control")).toBe("no-store");
  expect(await getTemplates(env.DB, f.ward.wardId)).toEqual(saved);

  expect((await postForm(realApp, f.path, { name: "架空の新しい知らせ", body }, f.cookie)).status).toBe(303);
  const result = await getTemplates(env.DB, f.ward.wardId);
  expect(result).toHaveLength(saved.length + 1);
  expect(result).toEqual([...saved, expect.objectContaining({ name: "架空の新しい知らせ", body })]);
});

it("訂正の名前を誤ってもその文だけに入力を残し、成功するまでは元の文を変えない", async () => {
  const f = await fixture();
  const target = saved[0]!;
  const other = saved[1]!;
  const path = `${f.path}/${target.id}`;
  const invalid = await postForm(realApp, path, { name: "  ", body }, f.cookie);
  expect(invalid.status).toBe(400);
  const html = await invalid.text();
  expect(form(html, path)).toContain(body);
  expect(form(html, path)).toContain('value="  "');
  expect(form(html, `${f.path}/${other.id}`)).toContain(other.body);
  expect(form(html, `${f.path}/${other.id}`)).not.toContain(body);
  expect(form(html, f.path)).not.toContain(body);
  expect(await getTemplates(env.DB, f.ward.wardId)).toEqual(saved);

  expect((await postForm(realApp, path, { name: "架空の直した知らせ", body }, f.cookie)).status).toBe(303);
  expect(await getTemplates(env.DB, f.ward.wardId)).toEqual([{ ...target, name: "架空の直した知らせ", body }, other]);
});
