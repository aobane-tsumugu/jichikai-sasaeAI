import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState, getProjectSummary } from "../project/api";
import { getEditableDocument } from "../project/actions";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, type DocumentKind } from "../project/model";
import { newId, nowIso } from "../core/ids";

interface Finding { kind: "名簿の名前" | "名簿の電話" | "協賛の額" | "個人の連絡先"; value: string; }
interface RosterRow { name: string; phone: string; }
const normalizePhone = (s: string) => s.replace(/[^0-9]/g, "");

async function saveRoster(db: D1Database, wardId: string, text: string): Promise<number> {
  if (text.length > 100000) throw new Error("名簿が大きすぎます");
  const rows: RosterRow[] = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = "", phone = ""] = line.split(/[\t,、]/, 2);
    return { name: name.trim(), phone: phone.trim() };
  }).filter((r) => r.name.length > 0 && r.name.length <= 100 && r.phone.length <= 40);
  if (rows.length > 5000) throw new Error("名簿が大きすぎます");
  await db.prepare("DELETE FROM check_roster WHERE ward_id = ?").bind(wardId).run();
  if (rows.length) await db.batch(rows.map((r) => db.prepare("INSERT INTO check_roster (ward_id, entry_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?)").bind(wardId, newId(), r.name, normalizePhone(r.phone), nowIso())));
  return rows.length;
}

async function scanDraft(db: D1Database, wardId: string, projectId: string, kind: DocumentKind): Promise<Finding[]> {
  const doc = await getEditableDocument(db, wardId, projectId, kind);
  if (!doc || doc.scope !== "public") return [];
  let body: { text?: string; items?: Array<{ key?: string; content?: string }> };
  try { body = JSON.parse(doc.body) as typeof body; } catch { return [{ kind: "個人の連絡先", value: "下書きの形を読めません" }]; }
  const text = [body.text ?? "", ...(body.items ?? []).map((i) => i.content ?? "")].join("\n");
  const found: Finding[] = [];
  const roster = await db.prepare("SELECT name, phone FROM check_roster WHERE ward_id = ? ORDER BY name").bind(wardId).all<RosterRow>();
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const phone = /(?:\+?81[- ]?)?0\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4}/g;
  const draftPhones = (text.match(phone) ?? []).map(normalizePhone);
  for (const entry of roster.results) {
    if (entry.name.length >= 2 && text.includes(entry.name)) found.push({ kind: "名簿の名前", value: entry.name });
    if (entry.phone.length >= 8 && draftPhones.includes(entry.phone)) found.push({ kind: "名簿の電話", value: entry.phone });
  }
  const state = await getProjectState(db, wardId, projectId);
  const privateRows = state ? state.tables.sponsors.flatMap((r) => [r.data.amount, r.data.lastYearAmount]).filter((v): v is string | number => v !== undefined).map(String) : [];
  const visibleAmounts = (text.match(/\d[\d,]*/g) ?? []).map((v) => Number(v.replace(/,/g, ""))).filter(Number.isFinite);
  for (const amount of privateRows.filter((v) => Number.isFinite(Number(v)))) {
    if (visibleAmounts.includes(Number(amount))) found.push({ kind: "協賛の額", value: amount });
  }
  const publicContact = state?.items.find((i) => i.key === "public_contact")?.current?.content ?? "";
  const allowed = (v: string) => publicContact.includes(v) || publicContact.replace(/\D/g, "").includes(v.replace(/\D/g, ""));
  for (const value of text.match(email) ?? []) if (!allowed(value)) found.push({ kind: "個人の連絡先", value });
  for (const value of text.match(phone) ?? []) if (normalizePhone(value).length >= 10 && !allowed(value)) found.push({ kind: "個人の連絡先", value });
  const unique = new Map(found.map((f) => [`${f.kind}:${f.value}`, f]));
  return [...unique.values()];
}

const admin = new Hono<AdminEnv>();
admin.get("/projects/:projectId/check", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const [project, rosterCount] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM check_roster WHERE ward_id = ?").bind(ward.wardId).first<{ count: number }>(),
  ]);
  if (!project) return c.notFound();
  const selected = c.req.query("document"); const kind = DOCUMENT_KINDS.includes(selected as DocumentKind) ? selected as DocumentKind : "announcement";
  const [findings, selectedDocument] = await Promise.all([scanDraft(c.env.DB, ward.wardId, id, kind), getEditableDocument(c.env.DB, ward.wardId, id, kind)]);
  return c.html(<Layout title="公開の下書きを確かめる" siteName={ward.name} noindex headerRight={<a href={adminPath(ward, `/projects/${id}`)}>プロジェクトへ</a>}>
    <h1>公開の下書きを確かめる</h1>
    {c.req.query("saved") === "1" ? <Notice>名簿を受け取りました。公開の下書きをもう一度確かめてください。</Notice> : null}
    {c.req.query("error") ? <Notice error>{c.req.query("error")}</Notice> : null}
    <p>公開の下書きに、名簿の名前や電話、協賛の額、個人の連絡先が混ざっていないかを照合します。名簿は照合のために受け取ります。</p>
    <h2>名簿を受け取る</h2><p>{rosterCount?.count ?? 0} 件を照合に使います。1 行に「名前,電話番号」の形で入れてください。電話番号は省略できます。</p>
    <form method="post" action={adminPath(ward, `/projects/${id}/check/roster`)}><label for="roster">名簿の内容</label><textarea id="roster" name="roster" rows={8} style="width:100%;font:inherit;padding:.65rem"></textarea><button>受け取る</button></form>
    <h2>確かめる文書</h2><form method="get" action={adminPath(ward, `/projects/${id}/check`)}><label for="document">文書</label><select id="document" name="document">{DOCUMENT_KINDS.map((k) => <option value={k} selected={k === kind}>{DOCUMENT_KIND_LABEL[k]}</option>)}</select><button class="secondary">開く</button></form>
    <h2>照合結果</h2>
    {selectedDocument && selectedDocument.scope !== "public" ? <Notice>この文書の範囲は公開ではありません。公開にする時に照合してください。</Notice> : findings.length ? <><p>公開する前に、次の箇所を確認してください。</p>{findings.map((f) => <p class="notice error">{f.kind}: {f.value}</p>)}</> : <Notice>{rosterCount?.count ? "照合で見つかった物はありません。" : "名簿は未登録です。名前と電話の照合は名簿を受け取ると行えます。"}</Notice>}
    <p><a href={adminPath(ward, `/projects/${id}/draft/${kind}`)}>案を直す</a> / <a href={adminPath(ward, `/publish/${id}`)}>配る</a></p>
  </Layout>);
});

admin.post("/projects/:projectId/check/roster", async (c) => {
  const { ward } = c.var; const form = await c.req.formData(); const id = c.req.param("projectId");
  try { await saveRoster(c.env.DB, ward.wardId, String(form.get("roster") ?? "")); return c.redirect(`${adminPath(ward, `/projects/${id}/check`)}?saved=1`, 303); }
  catch (e) { return c.redirect(`${adminPath(ward, `/projects/${id}/check`)}?error=${encodeURIComponent(e instanceof Error ? e.message : "名簿を受け取れませんでした")}`, 303); }
});

export { admin as checkAdmin };
export const check: Bundle = { admin };
