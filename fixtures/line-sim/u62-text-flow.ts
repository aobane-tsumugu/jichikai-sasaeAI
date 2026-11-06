// 区、行事、人名、会話はすべて架空です。公式への質問は62通の一覧と同じ文です。
import { LOCAL_FLOW } from "./local-flow";

export const U62_TEXT_FLOW = {
  projectTitle: LOCAL_FLOW.projectTitle,
  roster: LOCAL_FLOW.roster,
  attendance: "架空参加一郎です。1班です。架空の秋の収穫祭に大人2人で参加します。",
  decline: "架空欠席一郎です。1班です。架空の秋の収穫祭に参加しません。よろしくお願いします。",
  chat: "今日はよく晴れていますね。",
  report: "架空の秋の収穫祭の設営の相談は済みました。机を12台手配しました。",
  questions: [
    { group: true, text: "公式へ。架空の秋の収穫祭について、何時からですか。" },
    { group: false, text: "架空の秋の収穫祭について、雨のときはどこに行けばよいですか。" },
    { group: true, text: "公式へ。架空の秋の収穫祭について、車いすでも入れますか。" },
    { group: false, text: "架空の秋の収穫祭について、食べ物の持ち込みはできますか。" },
    { group: true, text: "公式へ。架空の秋の収穫祭について、忘れ物をしたらどこへ連絡すればよいですか。" },
    { group: false, text: "架空の秋の収穫祭について、トイレの場所を教えてください。" },
    { group: true, text: "公式へ。架空の秋の収穫祭について、手伝いは初めてでもできますか。" },
    { group: false, text: "架空の秋の収穫祭について、案内の紙をもう一枚もらえますか。" },
    { group: true, text: "公式へ。架空の秋の収穫祭について、駐輪する場所を教えてください。" },
    { group: false, text: "架空の秋の収穫祭について、食事の相談をしたいです。" },
  ],
} as const;
