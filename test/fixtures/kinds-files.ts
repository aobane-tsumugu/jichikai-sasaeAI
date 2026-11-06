// 日付を固定して再生成する架空資料。文だけの通しは従来どおり実行日の値を使う。
export const KINDS_FIXTURE_YEAR = 2026;
export const MEETING_FIXTURE_NOW = "2026-11-07T00:00:00Z";

export const KIND_FILES = {
  meetingAgenda: [
    "general_meeting/架空_去年の議案書.docx",
    "general_meeting/架空_去年の決算書.xlsx",
    "general_meeting/架空_前回の総会の議事録.jpg",
    "general_meeting/架空_今年の総会の資料.docx",
  ],
  meetingMinutes: ["general_meeting/架空_今年の総会の記録.jpg"],
  boardAgenda: ["board_meeting/架空_議題の紙.jpg"],
  boardMinutes: ["board_meeting/架空_議事のメモ.docx"],
  boardNextMinutes: ["board_meeting/架空_次の役員会のメモ.docx"],
  duty: ["duty/架空_去年の当番表.xlsx", "duty/架空_掲示の当番表.jpg"],
  city: ["city_request/架空_市の通知.pdf", "city_request/架空_回答の様式.docx"],
} as const;

export type KindFileGroup = keyof typeof KIND_FILES;
export type FixtureLoader = (path: string) => Promise<Uint8Array<ArrayBuffer>>;

// 画面がWordとExcelを開く処理を使い、元のバイトもmultipartで送る。
// 文字の写しだけを送った結果を、ファイルの受付の成功としない。
export async function kindFilesForm(projectId: string, group: KindFileGroup, load: FixtureLoader, page: string) {
  const form = new FormData();
  form.set("project_id", projectId);
  const script = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1] ?? "").find(body => body.includes("root.__sendOffice"));
  if (!script || !/id="send-form"/.test(page)) throw new Error("送る画面のファイルの入力欄がありません");
  const office = new Function("globalThis", "document", script + ";return globalThis.__sendOffice;")({}, undefined) as {
    extractOffice: (bytes: Uint8Array<ArrayBuffer>) => Promise<unknown>;
  };
  for (const path of KIND_FILES[group]) {
    const bytes = await load(path);
    const name = path.split("/").at(-1)!;
    const extension = name.split(".").at(-1)!;
    const types: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pdf: "application/pdf", jpg: "image/jpeg",
    };
    const type = types[extension];
    if (!type || bytes.length === 0) throw new Error("架空の資料ファイルを開けません");
    form.append("part", new Blob([bytes], { type }), name);
    form.append("part_kind", extension === "jpg" ? "photo" : "file");
    form.append("part_extracted", extension === "docx" || extension === "xlsx" ? JSON.stringify(await office.extractOffice(bytes)) : "");
  }
  return form;
}
