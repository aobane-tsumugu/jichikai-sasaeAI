// U51専用。資料、世帯、免除の理由はこの試験のために作ったもので、実在の資料ではない。
export function kindsMaterial(year = new Date().getUTCFullYear()) {
  const decision = "清掃用具は共同で購入することに決めました";
  const pending = "遊具の更新は話し合いを続けます";
  const nextDecision = "集会室の照明を交換することに決めました";
  const names = { retained: "継続一郎", exempt: "免除二郎", departed: "転出三郎", arrived: "転入四郎" };
  const dutyTitle = "集積所の当番";
  return {
    year, decision, pending, nextDecision, names, dutyTitle,
    agenda: `役員会の議題です。\n${year}年1月10日、集会室。\n議題は清掃用具の共同購入と遊具の更新です。まだ決めていません。`,
    minutes: `${year}年1月10日、集会室で役員会を開きました。\n${decision}。\n${pending}。`,
    nextMinutes: `${year}年2月10日、集会室で役員会を開きました。\n${nextDecision}。`,
    reason: "試しの介護の事情により当番を免除",
    slots: ["第1週", "第2週", "第3週"], task: "集積所の清掃",
    duty: `${year - 1}年の当番の表です。\n時間帯\t持ち場\t担当\n第1週\t集積所の清掃\t${names.retained}\n第2週\t集積所の清掃\t${names.exempt}\n第3週\t集積所の清掃\t${names.departed}`,
    city: `${year}年3月1日\n依頼：集会室の設備の状況を回答してください。\n提出先：地域担当窓口\n提出期限：${year}年3月31日\n回答様式：照明の数、交換の希望の有無。\n役員が回答する依頼です。住民へ配る案内ではありません。`,
    cityDraft: `集会室の設備の状況を回答します。\n提出先：地域担当窓口\n提出期限：${year}年3月31日\n回答様式：照明の数、交換の希望の有無。`,
  };
}
