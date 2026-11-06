import type { Bundle } from "../core/bundle";
import { getProjectState } from "../project/api";
import type { DocumentKind } from "../project/model";
import { getRoster } from "../answers/api";
import { getPublicContact } from "../settings/store";

interface Finding { kind: "名簿の名前" | "協賛の額" | "個人の連絡先" | "まだ決まっていないところ"; value: string; }
interface PrivateRow { person_fields: string | null; data: string; }
const normalizePhone = (s: string) => s.replace(/[^0-9]/g, "");

export async function checkPublicDraft(db: D1Database, wardId: string, projectId: string, _kind: DocumentKind, raw: unknown): Promise<string[]> {
  let body: { text?: string; items?: Array<{ key?: string; content?: string }> };
  if (typeof raw === "string") {
    try { body = JSON.parse(raw) as typeof body; } catch { return ["公開する文書の形を読めません"]; }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) body = raw as typeof body;
  else return ["公開する文書の形を読み取れません"];
  const text = [body.text ?? "", ...(body.items ?? []).map((i) => i.content ?? "")].join("\n");
  const found: Finding[] = [];
  if (text.includes("（確認中）")) found.push({ kind: "まだ決まっていないところ", value: "（確認中）" });
  const roster = await getRoster(db, wardId);
  for (const entry of roster) if (entry.household.length >= 2 && text.includes(entry.household)) found.push({ kind: "名簿の名前", value: entry.household });

  const state = await getProjectState(db, wardId, projectId);
  const normalizedText = text.normalize("NFKC");
  const numbers = [...normalizedText.matchAll(/\d[\d,]*/g)];
  for (const row of state?.tables.sponsors ?? []) {
    const name = String(row.data.name ?? "").normalize("NFKC");
    if (!name) continue;
    for (const amount of [row.data.amount, row.data.lastYearAmount]) {
      if (amount === undefined || !Number.isFinite(Number(amount))) continue;
      // 同じ協賛先の名前と額が40文字以内に並ぶときだけ知らせる。日付や人数の数字だけでは止めない。
      let nameAt = normalizedText.indexOf(name);
      while (nameAt >= 0) {
        const nearby = numbers.some((match) => {
          if (Number(match[0].replace(/,/g, "")) !== Number(amount)) return false;
          const start = Math.min(nameAt + name.length, match.index + match[0].length);
          const end = Math.max(nameAt, match.index);
          const between = normalizedText.slice(start, end);
          return end >= start && between.length <= 40 && !/[。！？]|\n\s*\n/.test(between);
        });
        if (nearby) { found.push({ kind: "協賛の額", value: String(amount) }); break; }
        nameAt = normalizedText.indexOf(name, nameAt + name.length);
      }
    }
  }

  const privateRows = await db.prepare(`SELECT person_fields, data FROM project_rows WHERE ward_id = ? AND project_id = ?`).bind(wardId, projectId).all<PrivateRow>();
  const privateValues = privateRows.results.flatMap((row) => {
    const values: string[] = [];
    for (const source of [row.person_fields, row.data]) {
      if (!source) continue;
      try {
        const value: unknown = JSON.parse(source);
        if (typeof value === "object" && value !== null) for (const item of Object.values(value)) {
          if (typeof item === "string" && item.trim()) values.push(item.trim());
        }
      } catch { /* 読めない補助情報は照合対象にしない */ }
    }
    return values;
  });
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const phone = /(?:\+?81[- ]?)?0\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4}/g;
  const publicContact = await getPublicContact(db, wardId);
  const publicEmails = new Set(publicContact.match(email)?.map((value) => value.toLowerCase()) ?? []);
  const publicPhones = normalizePhone(publicContact);
  const isAllowed = (value: string) => {
    if (email.test(value)) {
      email.lastIndex = 0;
      return publicEmails.has(value.toLowerCase());
    }
    email.lastIndex = 0;
    const digits = normalizePhone(value);
    return digits.length >= 8 && publicPhones.includes(digits);
  };
  const contacts = [...privateValues.filter((v) => /@|\d{8,}/.test(v)), ...(text.match(email) ?? []), ...(text.match(phone) ?? []).filter((v) => normalizePhone(v).length >= 10)];
  for (const value of contacts) if (!isAllowed(value) && text.includes(value)) found.push({ kind: "個人の連絡先", value });
  return [...new Map(found.map((f) => [`${f.kind}:${f.value}`, f])).values()].map((f) => `${f.kind}: ${f.value}`);
}

// 検査は配る内容の確認の中で呼ぶ。別の役員操作は置かない。
export const check: Bundle = {};
