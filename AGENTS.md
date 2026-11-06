# AGENTS.md

Codex が守る決まりです。詳しい決まりは CLAUDE.md、現在地は docs/STATE.md、設計の要約は docs/DESIGN.md にあります。最初に読んでください。日本語で作業し、絵文字は使いません。ファイルは UTF-8（BOM なし）、LF です。

## 連絡網

Claude との連絡網は GitHub の Issue #1 です。作業を始める前と、区切りごとに読みます。書き方は Issue の本文に従います。

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/aobane-tsumugu/jichikai-sasaeAI/issues/1/comments?per_page=100"
curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -d '{"body":"[Codex] 着手: ..."}' https://api.github.com/repos/aobane-tsumugu/jichikai-sasaeAI/issues/1/comments
```

`[Claude] 依頼` のうち、自分宛で「着手」が付いていない物を一つ取り、先に `[Codex] 着手` と書いてから始めます。依頼に無い作業を広げません。

担当の決まりは Issue #1 の「方針: 開発体制 第1版」に従います。dot の枠も同じです。先頭は `[dot]` を使います。読めない上位文書は、読んだ事にせず着手の時に書きます。依頼に書かれたファイルだけを触り、統合、配備、D1 の変更はしません。

## Cloudflare

環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID があれば `npx wrangler d1 execute DB --remote` が使えます。配備と D1 の変更は、依頼に書かれている時だけ行います。

## 検査

`npm run typecheck`と`npx vitest run`を通してから終えます。試験やgitを実行できない作業環境では、本人の指示に従って外側の実行に任せ、未実行と報告します。

## 守ること

- 画面と紙、操作手順の言葉はCLAUDE.mdの表にそろえます。行事、段取り、下書き、質問、資料、届いたもの、元の資料、実行委員と班長のページ、答えと書きます。形式名詞はかな、数字と英字の前後は空けません。コードの識別子、URL、フォームのnameは変えません。住民の見出しは頼む形にします。内部の言葉は住民向けの本文に書かせず、操作の誤りもLayoutで次の行動と戻る道を伝えます。

- 教えてくれる人がいない所から使い始める役員が、迷わず、試しながら進められる画面にします。画面そのものが次にすることを示し、押し間違えても戻せるようにします。何をする画面か、どう使うかの説明は、見出しの下の一行で読めるようにします。操作の影響など迷うところだけ、src/core/ui.tsxの`Hint`の「説明を読む」で開閉できる説明を残します。
- 過剰な検査、過剰な品質、使い勝手に寄与しない機能、使い勝手を悪くする機能、意味が無く消してよい機能は作りません。PM はそれを取り込みません。依頼の範囲より広げず、自分で仕事を探す時もこの基準で選びます。
- 秘密の値を画面、ログ、コミット、連絡網に書きません。
- 自治体名、本人の所属、他の参加者の名前を書きません。
- 公式 LINE の一斉送信をしません。GitHub を公開にしません。
- クロード区（/demoku/）に対して `npm run walkthrough` と `walkthrough-rest` を走らせません。
- 測っていない効果を書きません。

画面の短いサービス名は「SasaeAI」です。提供側への問い合わせフォームは作りません。役員がだれも入れないときと区を止めているときは、最初の案内の紙の連絡先へ案内します。
