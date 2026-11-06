import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { setAnswerDeadline } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { getDraftPack } from "../src/draft/packs";
import { DEFAULT_ANSWER_LABELS } from "../src/settings/answer-labels";
import { setSetting } from "../src/settings/store";
import { openSpace } from "../src/space/api";
import { get, postForm, realApp } from "./helpers";

it("資料も班もない一年目に案内を配り、紙だけで返す相手と締切が分かり、長い案内は回答票を分ける", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T03:00:00Z"));
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, {
      kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
    });
    const root = `/${ward.slug}/admin`;
    const publish = async (text: string, due?: string) => {
      const items = [
        { key: "date_time", content: FIRST_SLICE.eventDay },
        { key: "place", content: FIRST_SLICE.previousPlace },
        { key: "helper_slots", content: FIRST_SLICE.helperTime },
        ...(due ? [{ key: "due", content: due }] : []),
      ];
      expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
        kind: "announcement", title: "案内", scope: "public", basedOn: 0, body: JSON.stringify({ text, items }),
      })).toBe(true);
      const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
        WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
        .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
      if (!version) throw new Error("配る案内がありません。");
      expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
        documentId: version.document_id, versionId: version.version_id,
        versionNo: String(version.version_no), lineDelivery: "skip",
      }, cookie)).status).toBe(303);
      return `${root}/print/${project.projectId}/${version.document_id}/${version.version_no}`;
    };
    const read = async (path: string) => {
      const response = await get(realApp, path, cookie);
      expect(response.status).toBe(200);
      return response.text();
    };
    const first = await publish(FIRST_SLICE.draftText);
    const initial = await read(`${first}/announcement`);
    expect(initial).toContain(`<h1>${FIRST_SLICE.nextYearTitle}のご案内</h1>`);
    expect(initial.match(/class="sheet"/g)).toHaveLength(1);
    expect(initial).toContain("ここで切り取る");
    for (const path of ["announcement", "answer"]) {
      const html = await read(`${first}/${path}`);
      expect(html).toContain("代表者のお名前");
      for (const label of DEFAULT_ANSWER_LABELS) expect(html).toContain(label);
      expect(html).toContain(FIRST_SLICE.helperTime);
      expect(html).toContain("班（分からないときは空けてかまいません）");
      expect(html).toContain("班長か役員に渡してください。");
      expect(html).not.toContain("までに、");
      expect(html).not.toContain("連絡先：");
      expect(html).toContain("2026年9月10日に配りました");
      expect(html).toContain("紙の番号 P");
      expect(html).toContain(`href="${first}"`);
      expect(html).not.toContain("dense");
    }
    await openSpace(env.DB, ward.wardId, project.projectId, FIRST_SLICE.passphrase, account.accountId);
    const leaderResponse = await postForm(realApp, `${first}/leader`, {}, cookie);
    expect(leaderResponse.status).toBe(200);
    const leader = await leaderResponse.text();
    expect(leader).toContain("<h1>班長さんへ</h1>");
    expect(leader).toContain("「答えた世帯」に名前が出た回答票");
    expect(leader).toContain("名前が読めないようにして捨ててかまいません");
    expect(leader).toContain("ついでのときに役員に渡してください");
    expect(leader).not.toContain("なくしたとき、分からないときは");

    const long = await publish(Array.from({ length: 40 }, () => FIRST_SLICE.publicAnnouncement).join("\n"), FIRST_SLICE.eventDay);
    // 受付の設定が無い古い記録も、配った項目の締切を使う。
    await env.DB.prepare("DELETE FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'answer_due'")
      .bind(ward.wardId, project.projectId).run();
    expect(await read(`${long}/answer`)).toContain("10月23日（土）までに、");
    const override = `${FIRST_SLICE.nextYear}-10-24`;
    await setAnswerDeadline(env.DB, ward.wardId, project.projectId, override, account.accountId);
    await setSetting(env.DB, ward.wardId, "public_contact", FIRST_SLICE.firstOfficer, account.accountId);
    await setSetting(env.DB, ward.wardId, "squads", JSON.stringify([FIRST_SLICE.district]), account.accountId);
    await setSetting(env.DB, ward.wardId, "answer_labels", JSON.stringify(["子ども", "大人", "高齢の方"]), account.accountId);
    for (const path of ["announcement", "answer"]) {
      const html = await read(`${long}/${path}`);
      expect(html).toContain(`10月24日（日）までに、${FIRST_SLICE.district}の班長か役員に渡してください。`);
      expect(html).toContain(`分からないときは　${FIRST_SLICE.firstOfficer}`);
      for (const label of DEFAULT_ANSWER_LABELS) expect(html).toContain(label);
      expect(html.match(/class="sheet"/g)).toHaveLength(path === "announcement" ? 2 : 1);
    }
    const poster = await read(`${long}/poster`);
    expect(poster).toContain("答えの締切：10月24日（日）");
    expect(poster).toContain(FIRST_SLICE.firstOfficer);
    expect(poster).toContain("2026年9月10日に配りました");
    const pack = getDraftPack("announcement");
    expect(pack.version).toBe("draft-announcement@11");
    expect(pack.instruction).toContain("班長か役員に渡してください");
    expect(pack.instruction).toContain("ない時間帯、締切、連絡先を作らないでください");
  } finally {
    vi.useRealTimers();
  }
});
