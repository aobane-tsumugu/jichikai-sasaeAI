// kakuuだけに足す見本。世帯と進め方は全てこの見本のために作った試しのデータ。
import { getRoster, replaceRoster } from "../src/answers/api";
import type { WardInfo } from "../src/env";
import { addYearItem } from "../src/know/year";
import { getKnowItem, saveKnowItem } from "../src/know/store";
import { createProject } from "../src/project/api";
import { prepareRota } from "../src/rota/store";

export const KAKUU_YEAR_RECURRING = {
  year: 2026,
  garbage: { title: "ごみ当番", recurrence: "毎週月曜", weekday: 1 },
  delivery: { title: "市報の配布", recurrence: "毎月" },
  roster: ["青木", "石田", "上田"].map((household) => ({ household, district: "1班" })),
} as const;

/** 審査員用の自治会には入れない。呼び出し側もkakuuを明示する。 */
export async function seedKakuuYearRecurring(db: D1Database, ward: WardInfo, accountId: string, year = KAKUU_YEAR_RECURRING.year) {
  if (ward.slug !== "kakuu") throw new Error("この見本を入れられるのはkakuuだけです");
  const fixture = KAKUU_YEAR_RECURRING;
  if (!(await getRoster(db, ward.wardId)).length) await replaceRoster(db, ward.wardId, fixture.roster, { household: 0, district: 1 });
  for (const item of [fixture.garbage, fixture.delivery]) {
    const exists = await db.prepare("SELECT 1 AS ok FROM ward_year_items WHERE ward_id = ? AND title = ? AND recurrence_text <> ''")
      .bind(ward.wardId, item.title).first();
    if (!exists) await addYearItem(db, ward.wardId, { title: item.title, month: null, dateText: "", originalId: null, recurrence: item.recurrence });
  }
  for (const [key, body] of [["duties", "ごみ当番は毎週月曜。世帯の名簿の順に回します。"], ["delivery", "市報は毎月、班長が各世帯に配ります。"]] as const) {
    if (!(await getKnowItem(db, ward.wardId, key))?.body) await saveKnowItem(db, ward.wardId, key, { body });
  }
  const existing = await db.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND kind = 'duty' AND title = ? AND year = ? ORDER BY created_at DESC LIMIT 1")
    .bind(ward.wardId, fixture.garbage.title, year).first<{ project_id: string }>();
  const projectId = existing?.project_id ?? (await createProject(db, ward.wardId, { kind: "duty", title: fixture.garbage.title, year, accountId })).projectId;
  if (!await prepareRota(db, ward.wardId, projectId, accountId, fixture.garbage.weekday)) throw new Error("ごみ当番の見本を作れませんでした");
  return projectId;
}
