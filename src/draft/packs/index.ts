import type { DocumentKind } from "../../project/model";
import type { DraftPack } from "./types";

const common = `
プロジェクトの状態を引き、今年の中身と参考の中身を分けてください。
今年の案には今年の中身だけを使います。去年など過去の資料は、今年の中身が空の項目を考える参考にできますが、今年の事実として日付、時刻、場所、内容、金額、名前、担当を写してはいけません。参考を使う時も今年の確定事項のように書かず、必要なら役員への問いにしてください。
根拠のない内容、手順、連絡先、回答方法を作らないでください。分からない必須項目は items の content を空にし、write_question で役員に確認する問いを一つずつ書いてください。本文にも空欄の項目名を残してください。分からないことを「ありません」「決まり次第お知らせします」など、根拠のない説明に置き換えないでください。
住民が読む前提で、年配の人にも読みやすい短い文と見出しを使ってください。堅い言い回しや略語を避け、日付は状態に年があれば年も含め、紙に印刷しても必要な情報と行動が分かるようにしてください。Web を使えない人が答える場合は、回答票の戻し先と締切を分かる範囲で示してください。戻し先が分からない時は空欄と問いを残し、班長などを勝手に指定しないでください。
文書の種類で定めた内容だけを本文に含めてください。別の種類の文書の内容を混ぜないでください。
公開する文書には、名簿の名前や電話番号、協賛先の金額、個人の連絡先を入れないでください。公開用の連絡先だけを使います。人の名前や額が必要な内部文書は、状態にある情報だけを必要な範囲で使います。
配る操作はしません。結果は {text: string, items: [{key: string, content: string, source?: string}]} として write_change の draft に書き、pack_version と based_on_state_version も含めてください。項目には状態から分かる値だけを入れ、出どころが分かる時は source に示してください。`;

const packs: Record<DocumentKind, DraftPack> = {
  announcement: {
    version: "draft-announcement@2", kind: "announcement", title: "案内", scope: "public",
    instruction: `住民向けの行事案内を作ってください。日時、場所、雨天時、中身、持ち物、問い合わせ先を見出し付きで並べます。出欠や申込みを集める状態がある場合だけ、何を答えるか、締切、紙での答え方と Web での答え方を案内に含めます。紙だけを受け取った人が参加や回答に移れる案内にしてください。${common}`,
  },
  recruitment: {
    version: "draft-recruitment@2", kind: "recruitment", title: "手伝いの募集", scope: "public",
    instruction: `住民向けの手伝い募集を作ってください。手伝いの内容、時間帯、場所、申し出の締切、申し出方法、問い合わせ先を分かる範囲で含めます。状態にある募集内容だけを書き、加入を条件にしません。回答先や紙での申し出方法が分からない時は空欄と問いを残します。案内本文や出欠の案を混ぜません。${common}`,
  },
  duty_roster: {
    version: "draft-duty-roster@2", kind: "duty_roster", title: "当番表", scope: "space",
    instruction: `実行委員と班長向けの当番表を作ってください。状態にある時間帯、持ち場、担当だけを対応させ、担当が決まっていない欄は空けて役員への問いにします。参考の去年の担当者を今年の担当者として写しません。住民向けの案内文や募集文は作りません。${common}`,
  },
  procedure: {
    version: "draft-procedure@2", kind: "procedure", title: "進め方", scope: "space",
    instruction: `実行委員と班長向けに、地図の仕事に沿った準備と当日の進め方を短くまとめてください。状態にある仕事、時期、決めたことだけを書き、担当や手順が分からない所は空欄と問いにします。案内や募集の文面は混ぜません。${common}`,
  },
  notice: {
    version: "draft-notice@2", kind: "notice", title: "知らせ", scope: "public",
    instruction: `住民向けに、今年決まった変更だけを短く知らせてください。何が変わったか、変更後の日時や場所、雨天時、住民に必要な行動、問い合わせ先を状態から分かる範囲で含めます。紙だけを見た人にも変更後の内容が伝わるよう、変更前の案内や Web への参照だけで済ませません。未確認の変更は空欄と問いにします。${common}`,
  },
  report: {
    version: "draft-report@2", kind: "report", title: "報告", scope: "public",
    instruction: `行事の実施報告を、住民に向けて短く読みやすく作ってください。確認できる実施内容、人数、出来事だけを書き、分からない数や評価を推測しません。公開部分に収支、協賛額、名簿の名前や電話、個人の連絡先を含めません。役員だけの内容は公開本文に混ぜず、必要なら別の役員向け下書きにしてください。${common}`,
  },
};

export function getDraftPack(kind: DocumentKind): DraftPack { return packs[kind]; }
export function listDraftPacks(): DraftPack[] { return Object.values(packs); }
