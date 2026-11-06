import { DOCUMENT_KIND_LABEL, type DocumentKind, type ProjectKind } from "./model";

/** 出欠を集めるのは、行事と総会の案内だけ。 */
export function collectsAttendance(projectKind: string, documentKind: string): boolean {
  return (projectKind === "event" || projectKind === "general_meeting") && documentKind === "announcement";
}

/** 同じ六種類の文書を、仕事に合う題で画面と紙に出す。 */
const TITLES: Record<Exclude<ProjectKind, "event">, Record<DocumentKind, string>> = {
  general_meeting: { announcement: "総会の招集", recruitment: "総会の手伝いの募集", duty_roster: "総会の当番表", procedure: "議案の資料", notice: "総会の変更のお知らせ", report: "議事録" },
  board_meeting: { announcement: "役員会の招集", recruitment: "役員会の手伝いの募集", duty_roster: "役員会の当番表", procedure: "議題の資料", notice: "役員会の変更のお知らせ", report: "議事録" },
  duty: { announcement: "作業の案内", recruitment: "作業の手伝いの募集", duty_roster: "当番表", procedure: "作業の進め方", notice: "担当へのお知らせ", report: "作業の報告" },
  city_request: { announcement: "依頼のお知らせ", recruitment: "協力の募集", duty_roster: "担当の表", procedure: "回答の資料", notice: "依頼の変更のお知らせ", report: "提出する回答" },
  request: { announcement: "要望についてのお知らせ", recruitment: "協力の募集", duty_roster: "担当の表", procedure: "要望の資料", notice: "対応のお知らせ", report: "要望書" },
};

export function documentTitle(projectKind: ProjectKind, documentKind: DocumentKind): string {
  return projectKind === "event" ? DOCUMENT_KIND_LABEL[documentKind] : TITLES[projectKind][documentKind];
}

/** 本文の最初の行が見出しと同じ時は true。見出しの直下に同じ題を二度出さない。 */
function isTitleLine(line: string, projectTitle: string, documentTitle: string): boolean {
  const plain = (value: string) => value.replace(/[\s　■]/g, "");
  const text = plain(line);
  const title = plain(documentTitle);
  if (!text || text.length > 60 || !text.endsWith(title)) return text === plain(projectTitle) && !!text;
  const rest = text.slice(0, text.length - title.length).replace(/(?:のご|の|ご)$/, "");
  return !rest || plain(projectTitle).includes(rest);
}

export function withoutTitleLine(text: string, projectTitle: string, documentTitle: string): string {
  const [first = "", ...rest] = text.replace(/\r\n/g, "\n").trimStart().split("\n");
  return isTitleLine(first, projectTitle, documentTitle) ? rest.join("\n").trimStart() : text;
}

/** 紙や LINE の題だけでも何の話か分かるよう、文書の題に行事名が無ければ添える。 */
export function paperHeading(projectTitle: string, documentTitle: string): string {
  if (documentTitle.includes(projectTitle)) return documentTitle;
  return documentTitle === "案内" ? `${projectTitle}のご案内` : `${projectTitle} ${documentTitle}`;
}

