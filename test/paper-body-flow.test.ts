import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { PENDING, withoutPending, writtenInText } from "../src/project/document-body";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { withoutTitleLine } from "../src/project/heading";
import { paperGive, paperHelperSlots } from "../src/print/content";
import { articleParagraphs } from "../src/publish";
import { get, realApp } from "./helpers";

const meeting = "総会の招集\n\n■ 話し合うことをご確認ください\n・清掃活動の回数\n・遊具の更新\nどちらも、まだ決めていません。\n\n■ 2026年12月6日までにお答えください\n出席、委任、欠席のどれかをお答えください。\n・回答票を、班長か役員に渡してください。\n・Webでは、この案内のQRか区のページから答えてください。\n\n■ 問い合わせはこちらへ\n（確認中）";
const summary = "議案：清掃活動の回数、遊具の更新。いずれもまだ決めていません。出席、委任、欠席を、回答票（班長か役員に渡す）またはWeb（案内のQRか区のページ）で答える。";

it("まだ決まっていない所は、見出しごと、文ごと外す", () => {
  expect(withoutPending("■ 持ち物\n（確認中）\n\n■ 連絡先\n架空の窓口")).toBe("■ 連絡先\n架空の窓口");
  expect(withoutPending("持ち物：（確認中）\n架空の文です。")).toBe("架空の文です。");
  expect(withoutPending("架空の文です。連絡先は（確認中）です。")).toBe("架空の文です。");
  expect(withoutPending("問い合わせはこちらへ（確認中）")).toBe("");
  expect(withoutPending("説明の文です。\n（確認中）")).toBe("説明の文です。");
  expect(withoutPending("■ 持ち物\n\n（確認中）")).toBe("");
});

it("本文の最初の行が題と同じ時だけ外す", () => {
  expect(withoutTitleLine("総会の招集\n\n本文", "架空の総会", "総会の招集")).toBe("本文");
  expect(withoutTitleLine("秋の収穫祭のご案内\n\n本文", "秋の収穫祭", "案内")).toBe("本文");
  expect(withoutTitleLine("■ 秋の収穫祭のご案内\n本文", "秋の収穫祭", "秋の収穫祭のご案内")).toBe("本文");
  expect(withoutTitleLine("案内を読んでください\n本文", "秋の収穫祭", "案内")).toBe("案内を読んでください\n本文");
  expect(withoutTitleLine("春の集まりのご案内\n本文", "秋の収穫祭", "案内")).toBe("春の集まりのご案内\n本文");
});

it("本文に書いた項目は紙にもページにも重ねて出さない", () => {
  expect(writtenInText("content", summary, meeting)).toBe(true);
  expect(writtenInText("content", "豚汁、焼き芋、新米のおにぎり、輪投げ、抽選", "今年も架空の行事を行います。")).toBe(false);
  expect(articleParagraphs(JSON.stringify({ text: meeting, items: [{ key: "content", content: summary }, { key: "public_contact", content: PENDING }] }), { project: "架空の総会", document: "総会の招集" }).join("\n"))
    .toBe(articleParagraphs(JSON.stringify({ text: meeting.replace("総会の招集\n\n", ""), items: [] })).join("\n"));
});

it("締切が日付の文なら一文で渡す先まで書く", () => {
  expect(paperGive("2026年10月9日まで", "班長か役員")).toEqual(["2026年10月9日までに、班長か役員に渡してください。"]);
  expect(paperGive("10/9まで（班長の紙で）", "班長か役員")).toEqual(["締切: 10/9まで（班長の紙で）", "班長か役員に渡してください。"]);
});

it("総会の招集の紙に、同じ題と同じ内容と確認中を出さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: "架空の総会", year: 2026, accountId: account.accountId });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "総会の招集", scope: "public", basedOn: 0, body: JSON.stringify({ text: meeting, items: [{ key: "content", content: summary }, { key: "public_contact", content: PENDING }] }) });
  const doc = await env.DB.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).first<{ document_id: string }>();
  const page = await (await get(realApp, `/${ward.slug}/admin/print/${project.projectId}/${doc!.document_id}/1/preview`, cookie)).text();
  expect(page).not.toContain(PENDING);
  expect(page).not.toContain("<p>総会の招集</p>");
  expect(page).not.toContain('class="paper-facts"');
  expect(page).toContain("清掃活動の回数");
});

it("中身の無くなった見出しを残さず、日付は読める形で出す", () => {
  expect(withoutPending("架空の文です。\n\n■ 連絡先\n連絡先：（確認中）")).toBe("架空の文です。");
  expect(withoutPending("【分からないことは連絡してください】\n電話：（確認中）")).toBe("");
  expect(withoutPending("■ 連絡先\n連絡先：（確認中）\n架空の窓口")).toBe("■ 連絡先\n架空の窓口");
  expect(articleParagraphs(JSON.stringify({ text: "架空の文です。", items: [{ key: "due", content: "2026-10-09" }] })).join("")).toContain("10月9日");
  expect(articleParagraphs(JSON.stringify({ text: "架空の文です。", items: [{ key: "place", content: "公民館前の広場" }] }), undefined, "announcement", ["place"])).toEqual(["架空の文です。"]);
});

it("AIの文に混ざった書式の記号を、読める形にする", () => {
  expect(articleParagraphs(JSON.stringify({ text: "## いつ\n- 午前\n- 午後\n\n**大事**です。", items: [] }))).toEqual(["■ いつ\n・午前\n・午後", "大事です。"]);
  expect(paperHelperSlotsCheck()).toBe("設営 受付 模擬店 片付け");
});
const paperHelperSlotsCheck = () => paperHelperSlots("設営 受付 模擬店 片付け");
