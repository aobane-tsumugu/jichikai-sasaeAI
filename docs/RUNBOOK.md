# 通しの手順書: 秋の収穫祭を段 0 から段 6 まで

この手順は、架空の自治会「クロード区」で、2026 年の秋の収穫祭を準備するためのものです。公開側の基点 URL は `https://jichikai.aobane-tsumugu.com/demoku/` です。fixtures のデータと画像はすべて架空です。実行結果や画面の見え方をこの文書だけで保証せず、確かめていない箇所には「実機で未確認」と記します。

画面と URL は `src/` の現行経路に合わせています。以下の `{projectId}`、`{documentId}`、`{versionNo}`、`{publicationId}` は実際に作成・表示された値に置き換えてください。役員用画面は `https://jichikai.aobane-tsumugu.com/demoku/admin/`、区の公開ページは `https://jichikai.aobane-tsumugu.com/demoku/` です。各ページは画面のリンクか、記載した URL から開きます。

## 0. 始める前に

### 0.1 使う画面と安全

| 画面 | URL | 用途 |
|---|---|---|
| 運用の画面 | `https://jichikai.aobane-tsumugu.com/ops/login` | 提供側が区を開く |
| 区の公開ページ | `https://jichikai.aobane-tsumugu.com/demoku/` | 公開中のお知らせと回答入口 |
| 役員画面 | `https://jichikai.aobane-tsumugu.com/demoku/admin/` | ログイン後の役員用機能 |
| 回答ページ | `https://jichikai.aobane-tsumugu.com/demoku/answer/{projectId}` | 住民の Web 回答 |
| プロジェクトの空間 | `https://jichikai.aobane-tsumugu.com/demoku/space/{projectId}` | 招待された実行委員・班長 |

- 運用の画面には提供側の ID とパスワードを使います。役員画面には発行された役員名とパスワードを使います。秘密の値はこの手順書、画面写真、ログ、証拠に書き写しません。
- `src/ops/index.tsx` に区の開設画面と `scripts/open-ward.ts` があり、開設スクリプトの形は `npm run open-ward -- --name "架空の区" --slug kakuu --first "最初の役員名"` です。配備先に対して実行する時は `--base`、鍵ファイルは `--keys` または `JICHIKAI_KEYS_FILE` で指定します。値そのものは記録しません。発行された初期パスワードは一度だけ確認して安全に渡します。
- Word と Excel を送る時は Chrome または Edge を使います。送信後の読み取り結果は実機で未確認です。
- 公式 LINE は一斉送信しません。「配る」の画面では、毎回「公式 LINE」で必ず「今回は送らない」を選びます。次の「配る内容の確認」に「今回は公式 LINE に送りません。」と出ていることを読んでから「配る」を押します。
- 公開配布の前に `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/check` で公開案内を確かめます。

### 0.2 fixtures の実ファイル

| 段 | ファイル |
|---|---|
| 0 | `fixtures/roster/加入世帯_2026秋.csv` |
| 1 | `fixtures/last-year/secretary/お知らせ_最終2.docx`、`fixtures/last-year/secretary/実施報告_去年.docx`、`fixtures/last-year/accountant/IMG_2081.jpg`、`fixtures/last-year/accountant/領収_その1.jpg`、`fixtures/last-year/vice-chair/実行委員_去年.xlsx`、`fixtures/last-year/vice-chair/当日配布.pdf`、`fixtures/last-year/vice-chair/配置のメモ.jpg`、`fixtures/this-year/chair/市からの通知.jpg` |
| 2 | `fixtures/this-year/meeting/役員会のメモ.jpg`、`fixtures/this-year/meeting/電話の結果_公民館.txt`、`fixtures/this-year/accountant/協賛先の一覧_今年の返事.jpg` |
| 3 | `fixtures/this-year/answers/回答票_2班.jpg`、`fixtures/this-year/answers/回答票_3班.jpg`、`fixtures/this-year/answers/Web回答.json`、`fixtures/this-year/answers/電話_木村の訂正.txt`、`fixtures/this-year/answers/電話_田中.txt`、`fixtures/this-year/answers/LINE_返事.txt`、`fixtures/this-year/answers/LINE_webhook.json` |
| 4 | `fixtures/this-year/rota/当番表_実行委員長の書込み.jpg`、`fixtures/this-year/rota/配置図_今年の晴天.jpg` |
| 5 | `fixtures/this-year/rain/10月23日_雨天の判断.txt` |
| 6 | `fixtures/this-year/day/当番表_当日の書込み.jpg`、`fixtures/this-year/day/領収書_今年_食材.jpg`、`fixtures/this-year/day/レシート_今年_文具.jpg`、`fixtures/this-year/day/会計メモ_今年.txt` |

`.txt` の本文を役員画面の「送る」にある「一行の文（電話や立ち話で決まったことなど）」欄へ貼り、「送る」を押します。JSON は画面フォームにそのまま読み込む機能があるとは確認できていません。Web 回答は JSON の各項目を回答画面に手入力してください。

## 段 0: 区を開き、名簿を登録する

1. 提供側は `https://jichikai.aobane-tsumugu.com/ops/login` を開き、「ログイン」します。
2. 区の一覧にある「区を開く」フォームへ、区の名前「クロード区」、URL `demoku`、最初の役員名を入力し、「開く」を押します。発行結果には区のページ、役員画面、QR、初期アカウントが表示されます。初期パスワードは記録に転記しません。
3. 役員は `https://jichikai.aobane-tsumugu.com/demoku/admin/login` で「ログイン」します。
4. `https://jichikai.aobane-tsumugu.com/demoku/admin/answers/roster` を開き、「名簿ファイル」に `fixtures/roster/加入世帯_2026秋.csv` を指定して「名簿を読み込む」を押します。見出し行から列を検出できない場合は「世帯名と班の項目を選んでください」で「世帯名」と「班」を選び、「名簿を入れる」を押します。

画面に実装されている表示: 名簿登録後、「班ごとの部数」と「世帯と班」の表が出ます。CSV の読み取り結果・54 世帯の班別内訳は実機で未確認です。区の公開ページに名簿が表示されないことも、実画面で確認します。

## 段 1: 去年の資料を登録する

1. `https://jichikai.aobane-tsumugu.com/demoku/admin/projects` を開き、「プロジェクトを開く」で「種類」を「行事」にし、「題（後で直せます）」と「行事の日（分かれば。地図の時期に使います）」を入れて「開く」を押します。作成後の URL にある `{projectId}` を控えます。
2. `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/map` で地図を確認します。「仕事を足す」の「仕事の名前」を入れて「足す」で追加し、「時期や担当を直す」を開いて「保存」で編集します。初期地図の仕事名・日付・進み具合は実機で未確認です。
3. `https://jichikai.aobane-tsumugu.com/demoku/admin/intake` を開き、対象プロジェクトを選んで、段 1 の資料 7 点（secretary 2 点、accountant 2 点、vice-chair 3 点）を順に送ります。「ファイルを選ぶ」からファイルを指定し、「送る」を押します。Word / Excel はブラウザで展開する表示が出た場合、画面を開き直して再送します。
4. 市の通知をまだ行事に当てない場合は、同じ画面の「どのプロジェクトか」で「プロジェクトに当てず受け箱へ」を選んで「送る」を押します。この資料を送った結果と AI の振り分けは実機で未確認です。
5. 処理状況は「入った物」の一覧で確認します。送信直後の実装メッセージは「受けました。閉じても処理は続きます。読み終わると、次に開いた時に見えます。」です。同一ファイルの重複時は「同じ物でした。」と表示されます。
6. プロジェクトの材料・問い・今年の中身は `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}` で確認します。公開案内の下書きは `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/draft`、混入確認は `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/check` です。各ページへは直接移動します。

読み取り結果、2025 年の参考情報への振り分け、出典の表示、個人情報の範囲、問いの生成、公開案内への自動反映は実機で未確認です。表示が実際に確かめられるまでは、期待値を実装済みの動作として扱わないでください。

## 段 2: 今年の決定を記録し、公開する

1. `https://jichikai.aobane-tsumugu.com/demoku/admin/intake` から、段 2 の 3 点を指定して送ります。文書は「ファイルを選ぶ」、電話結果の本文は「一行の文（電話や立ち話で決まったことなど）」、送信ボタンは「送る」です。
2. `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}` で「今年の中身」と「問い」を確認します。問いに選択肢があればそのボタンを押し、なければ「答え」に入力して「答える」を押します。「分からない」「後で」も選べます。AI が資料を正しく読んで日時・場所・協賛などへ反映することは実機で未確認です。
3. `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/draft` を開き、対象文書を選びます。案をAIに依頼するボタンは「AIに案を起こしてもらう」です。文面を手入力・修正する場合は「直した中身を保存」を押します。種類「案内」「手伝いの募集」を確認します。
4. `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/check` の「公開の下書きを確かめる」で「文書」を選び「開く」を押します。登録済みの名簿などを使う「照合結果」を読み、必要なら「案を直す」へ進みます。個人情報をすべて検出するかは実機で未確認です。
5. `https://jichikai.aobane-tsumugu.com/demoku/admin/publish/{projectId}` の「紙の配布先」で「班を選ぶ」または「世帯を選ぶ」を選び、「班ごとの部数」や配る世帯を確認します。「公式 LINE」は必ず「今回は送らない」を選び、「配る内容を確認する」を押します。次の「配る内容の確認」で本文・紙の配布先と「今回は公式 LINE に送りません。」を読み、「配る」を押します。世帯を選んで実際に配った結果は実機で未確認です。
6. 公開結果は `https://jichikai.aobane-tsumugu.com/demoku/p/{projectId}` と公開一覧 `https://jichikai.aobane-tsumugu.com/demoku/` で確認します。公開リンク、回答入口はコードにあります。文面・表示は実画面で確認します。公式 LINE の送信は行いません。
7. 印刷は `https://jichikai.aobane-tsumugu.com/demoku/admin/print/{projectId}/{documentId}/{versionNo}` を開き、実際のリンク「案内と回答票」「回答票」「班長への一枚」「当番表と配置図」「役員会の記入欄」「協賛先の一覧」から選びます。ブラウザ印刷の見え方、班別の部数が名簿と合うことは実機で未確認です。

## 段 3: 回答を集める

1. 住民の Web 回答 URL は `https://jichikai.aobane-tsumugu.com/demoku/answer/{projectId}` です。画面の「世帯名」「班」「参加人数」「手伝う人の名前」「手伝える時間帯」を入力し、「回答を送る」を押します。`fixtures/this-year/answers/Web回答.json` の 3 件は画面に手入力します。
2. 役員が電話回答を代理入力する場合は `https://jichikai.aobane-tsumugu.com/demoku/admin/answers/{projectId}` を開き、「電話の代理入力」の欄を埋めて「回答を入れる」を押します。電話の `.txt` の内容を AI が読んで回答登録する経路は実機で未確認です。
3. 紙の回答票は同じ役員回答 URL の「回答票を読み取る」で「回答票の写真」または「またはファイル」から選び、「回答票を送る」を押します。「回答票の読み取り」で確認・修正して「回答に入れる」を押します。元の写真は「回答票の原本を開く」で開けます。
4. 集計は同画面の「参加人数」「手伝いの希望」、「回答の一覧」、「未回答（班ごと）」、「手伝いの一覧」で確認できます。名簿と同姓世帯の自動照合、同一世帯の重複排除、期待件数は実機で未確認です。
5. LINE の受信は `https://jichikai.aobane-tsumugu.com/hooks/line` の webhook 経路があります。fixture の `LINE_webhook.json` を直接送る手順・署名生成手段はこの画面実装からは確認できません。受信された項目は役員の `https://jichikai.aobane-tsumugu.com/demoku/admin/inbox`（「受け箱」）で確認し、「選んだプロジェクトに当てる」「新しいプロジェクトを開く」「関係ない物として消す」を選べます。AI の自動振り分け・雑談処理・会話内回答抽出は実機で未確認です。

締切は回答管理画面の「締切日（延長する場合は新しい日）」に入力し「締切を保存」です。回答一覧・未回答一覧を印刷するボタンは「印刷する」です。

確認用に入れた Web・電話の回答を消す場合は、`https://jichikai.aobane-tsumugu.com/demoku/admin/settings/deletion` の「消す求め」を開きます。「Web と電話で受けた回答」で対象の行を選び、「この回答を消す」を押します。「この回答を消します。続けますか？」で対象を確認して進むと、「回答を消しました。毎日の写しからも、続けて消します。」と表示されます。回答票の写真から入った回答は「対象の記録」の「消去を進める」で原本と一緒に消す作りです。この手順書の作業では実機で未確認です。

## 段 4: 当番表と配置図を扱う

1. 回答管理画面で「回答の一覧」「未回答（班ごと）」「手伝いの一覧」を読みます。案の画面 `https://jichikai.aobane-tsumugu.com/demoku/admin/projects/{projectId}/draft` で「当番表」の「AIに案を起こしてもらう」を押せます。生成内容は実機で未確認です。手で直す場合は「当番の担当を直す」の各行で「この行を保存」を押します。
2. `fixtures/this-year/rota/当番表_実行委員長の書込み.jpg` と `fixtures/this-year/rota/配置図_今年の晴天.jpg` は `https://jichikai.aobane-tsumugu.com/demoku/admin/intake` からプロジェクトを指定して「送る」ことができます。
3. 当番・配置への読み取り反映は実機で未確認です。実行委員・班長の空間は `https://jichikai.aobane-tsumugu.com/demoku/admin/space/{projectId}` で「合言葉」を入れて「空間を開く」を押します。必要に応じて「招待リンクを作る」または「専用URLを作る」を使います。班長 URL は該当班長だけに渡します。配る画面で当番表の「空間に配る」を押す操作と、空間に表示された内容は実機で未確認です。
4. メンバーは `https://jichikai.aobane-tsumugu.com/demoku/space/{projectId}` に入り、実際のボタン「入る」で合言葉を送信します。参加後、許可された範囲の出欠、協賛先、当番表と配置図、当日の紙などが表示されます。「写真またはファイル」から送る操作は「送る」です。班別表示の範囲やデータ内容は実機で未確認です。

## 段 5: 雨天の変更を記録して再配布する

1. `fixtures/this-year/rain/10月23日_雨天の判断.txt` の本文を `https://jichikai.aobane-tsumugu.com/demoku/admin/intake` の「一行の文（電話や立ち話で決まったことなど）」に貼り、「送る」を押します。
2. `https://jichikai.aobane-tsumugu.com/demoku/admin/settings/templates` で定型文を直す場合は「保存する」を押します。案の画面で「案内」または「知らせ」を開き、「雨天の知らせをすぐ用意」の「定型文」「行事名」「変更後の会場」「日時」を入れて「定型文で知らせを作る」を押せます。差し込んだ内容は実機で未確認です。
3. 案の画面で文を直し、「直した中身を保存」を押します。`https://jichikai.aobane-tsumugu.com/demoku/admin/publish/{projectId}` では、改めて「公式 LINE」を必ず「今回は送らない」にして「配る内容を確認する」を押します。確認画面の「今回は公式 LINE に送りません。」を読んで「配る」を押します。区のページでは今の案内を読み、以前の内容は「変更前の案内」（後ろに掲載日が付きます）を開いて読みます。実際の表示内容は実機で未確認です。
4. 配る画面の「これまでに配った案内」にある「公開を下げる」は、公開を取り下げる操作です。下書きの「前の案」にある「この案に戻す」は、以前の下書きに戻す操作です。配った内容を戻すボタンとは別です。戻した案を配り直す場合も、手順3で「今回は送らない」を選びます。
5. AI の鍵を外した状態での各画面・手動公開の可否は実機で未確認です。この手順では鍵を変更しません。

## 段 6: 実施報告を作り、閉じて記録する

1. `fixtures/this-year/day/当番表_当日の書込み.jpg` は空間からメンバーが「写真またはファイル」で選び「送る」か、役員が `https://jichikai.aobane-tsumugu.com/demoku/admin/intake` から送れます。領収書・レシート・会計メモも `https://jichikai.aobane-tsumugu.com/demoku/admin/intake` からプロジェクトを選び「送る」で登録します。
2. 収支・出欠・出席の紙の読み取りが期待値どおりになるかは実機で未確認です。領収書 1 枚から支出全額を判断しないでください。読み取り後、役員が表示を確かめます。
3. `https://jichikai.aobane-tsumugu.com/demoku/admin/close/{projectId}` を開きます。「報告と地図の下書きを起こす」で生成を依頼し、「公開する部分」「役員だけの部分」を必要に応じて編集して「保存」します。プロジェクト地図の各項目は「仕事の時期」「仕事の名前」「進み具合」「頼んだ人」「困ったこと」「来年変えること」を編集し、「この仕事を保存」します。AI の生成結果と公開情報の混入は実機で未確認です。
4. 報告を配る場合は案の画面で「報告」を開き、直して「直した中身を保存」を押します。`https://jichikai.aobane-tsumugu.com/demoku/admin/publish/{projectId}` で選ぶ際も「公式 LINE」は必ず「今回は送らない」を選びます。「配る内容を確認する」→「今回は公式 LINE に送りません。」を確認→「配る」の順です。閉じる画面に保存した報告と、配る報告の内容の一致は実機で未確認です。
5. 内容を保存した後、「閉じて記録に残す」を押し、「閉じると、報告と地図は記録になり書き直せません。実行委員と班長は空間を開けなくなります。閉じますか？」を読んで判断します。閉じた後は「このプロジェクトは閉じました。記録として読めます。」と表示され、「記録を開く」から記録を読めます。この操作の実機確認は、デモの「秋の収穫祭」を閉じず、確認用のプロジェクトで Claude が行います。この手順書の作業では実機の閉じる操作をしていません。
6. 記録詳細で題、年、行事の日を入力し「この地図を種に開く」と、翌年のプロジェクトを作れます。2027 年用の地図が期待どおり日程を移すことは実機で未確認です。

## 作りながら直す所

- **コードで確認**: 「プロジェクトに当てず受け箱へ」「AIに案を起こしてもらう」「空間を開く」「空間に配る」「定型文で知らせを作る」「この案に戻す」「報告と地図の下書きを起こす」「閉じて記録に残す」の経路と表示名があります。これらを未実装とは扱いません。実機の確認結果は docs/STATE.md を参照します。
- **実機で未確認**: 段 1 の通知 fixture を受け箱へ送り、AI が行事に当てるまでの一連の結果。
- **実機で未確認**: 段 4 の回答から作った当番表の内容と、空間に配った後の表示内容。
- **実機で未確認**: 段 5 の定型文から作った知らせと、以前の案に戻して配り直した後の内容。
- **実機で未確認**: 段 6 の当日実績を含む報告の内容と、配った公開報告との一致。AI の案を正式な決定として保存する操作はありません。
- **実機で未確認**: fixtures を使った AI 読み取りの内容・精度、問い・出典・年ごとの参考情報への反映、個人情報の混入検査、Web/電話/紙/LINE の統合結果、班長ごとの見える範囲、印刷物の実表示、AI 停止中の操作。
- **実機で未確認**: 配備済み環境の画面と送信先設定。コードに経路があることは、配備と実際の動作を確認したことを意味しません。

## 合成画像について

`fixtures/` の写真風画像はプログラムで作った合成で、実際の写真や手書きではありません。合成画像での読み取り結果は、本物の手書き・スマートフォン写真での結果とは別に記録します。fixture の説明は [fixtures/README.md](../fixtures/README.md) を参照してください。

## 日次の写しから戻す

写しは DAILY の Cron で毎日作られます。区ごとに `snapshots/daily/YYYY-MM-DD.json` へ保存され、原本や配布記録などの正本を含みます。読み取り結果、実行記録、検索用の索引など、元の情報から作り直せる内容は含みません。原本ファイル本体は写しの JSON ではなく、同じ区の R2 にある原本のままです。

1. 戻し先の D1 と R2 を用意し、現在の `migrations/` を適用します。区のデータが空であることを確かめます。既存データへそのまま流すと重複や衝突になります。
2. 使う区の ID と日付を選び、次の形で R2 から JSON を取得します。`<ward-id>` と日付は実値に置き換えます。

   ```powershell
   npx wrangler r2 object get jichikai-sasae-staging/<ward-id>/snapshots/daily/YYYY-MM-DD.json --remote --file .\ward-snapshot.json
   ```

3. 取得した JSON を確認して SQL にします。

   ```powershell
   node scripts/snapshot-to-sql.mjs .\ward-snapshot.json .\ward-restore.sql
   ```

   この変換は、全行の `ward_id` が写しの区 ID と一致することを確かめ、表と行の順に `INSERT` 文を書きます。生成した SQL は個人情報を含むので、作業後に安全に消します。
4. 新しい空のデータベースへ実行します。

   ```powershell
   npx wrangler d1 execute jichikai-sasae-staging --remote --file .\ward-restore.sql
   ```

5. 件数と代表的なプロジェクト、役員アカウント、公開記録を確認します。別の D1 に戻す場合は、その区の原本 R2 も同じ区 ID のキーを保って復元してください。原本の写しも必要な場合は `originals` 表の `r2_path` を参照し、対象キーだけを同じ `WardBucket` の区内に戻します。

復元後に `readings`、実行記録、検索索引は空です。検索索引は記録の再構築処理で作り直します。日次写しと復元は、この作業区ではまだ実機で確認していません。
