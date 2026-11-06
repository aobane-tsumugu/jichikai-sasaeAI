import { DOCUMENT_KIND_LABEL, type DocumentKind, type ProjectKind } from "./model";

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

/** 紙や LINE の題だけでも何の話か分かるよう、文書の題に行事名が無ければ添える。 */
export function paperHeading(projectTitle: string, documentTitle: string): string {
  return documentTitle.includes(projectTitle) ? documentTitle : `${projectTitle} ${documentTitle}`;
}

