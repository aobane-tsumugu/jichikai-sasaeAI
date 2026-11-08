import type { Bundle } from "../core/bundle";
import { getProjectState } from "../project/api";
import type { DocumentKind } from "../project/model";
import { getRoster } from "../answers/api";
import { getPublicContact } from "../settings/store";
import { isCalendarDay } from "../core/time";

interface Finding { kind: "名簿の名前" | "協賛の額" | "個人の連絡先" | "まだ決まっていないところ" | "去年の日付のようです"; value: string; }
interface PrivateRow { person_fields: string | null; data: string; }
const normalizePhone = (s: string) => s.replace(/[^0-9]/g, "");

export async function checkPublicDraft(db: D1Database, wardId: string, projectId: string, kind: DocumentKind, raw: unknown): Promise<string[]> {
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
  if (state && ["announcement", "recruitment", "notice"].includes(kind)) {
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const dates = /(?:(?:(\d{4})\s*(?:年|[-/])|令和(元|\d{1,2})年|平成(元|\d{1,2})年)\s*)?(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})\s*日?/g;
    for (const part of [body.text ?? "", ...(body.items ?? []).map((item) => item.content ?? "")]) {
      const normalized = part.normalize("NFKC");
      let explicitYear: number | undefined;
      for (const match of normalized.matchAll(dates)) {
        const year = match[1] ? Number(match[1]) : match[2] ? 2018 + (match[2] === "元" ? 1 : Number(match[2]))
          : match[3] ? 1988 + (match[3] === "元" ? 1 : Number(match[3])) : explicitYear ?? state.project.year;
        explicitYear = year;
        const day = `${year}-${match[4]!.padStart(2, "0")}-${match[5]!.padStart(2, "0")}`;
        if (!isCalendarDay(day)) continue;
        const lineStart = normalized.lastIndexOf("\n", match.index) + 1;
        const lineEnd = normalized.indexOf("\n", match.index);
        const line = normalized.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        // 変更前や過去の実績を説明する日付は、当日や締切とは分ける。
        const historical = /昨年|去年|前回|変更前|実施した|開催した|行いました|行われました/.test(line)
          && !/締切|締め切|までに|集合/.test(line);
        if (year < state.project.year || (!historical && day < today)) found.push({ kind: "去年の日付のようです", value: match[0] });
      }
    }
  }
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
