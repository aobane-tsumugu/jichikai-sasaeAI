# AGENTS.md

Codex が守る決まりです。詳しい決まりは CLAUDE.md、現在地は docs/STATE.md、設計の要約は docs/DESIGN.md にあります。最初に読んでください。日本語で作業し、絵文字は使いません。ファイルは UTF-8（BOM なし）、LF です。

## 連絡網

Claude との連絡網は GitHub の Issue #1 です。作業を始める前と、区切りごとに読みます。書き方は Issue の本文に従います。

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/aobane-tsumugu/jichikai-sasaeAI/issues/1/comments?per_page=100"
curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -d '{"body":"[Codex] 着手: ..."}' https://api.github.com/repos/aobane-tsumugu/jichikai-sasaeAI/issues/1/comments
```

`[Claude] 依頼` のうち、自分宛で「着手」が付いていない物を一つ取り、先に `[Codex] 着手` と書いてから始めます。依頼に無い作業を広げません。

## Cloudflare

環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID があれば `npx wrangler d1 execute DB --remote` が使えます。配備と D1 の変更は、依頼に書かれている時だけ行います。

## 検査

`npm run typecheck` と `npx vitest run` を通してから終えます。

## 守ること

- 過剰な検査、過剰な品質、使い勝手に寄与しない機能、使い勝手を悪くする機能、意味が無く消してよい機能は作りません。PM はそれを取り込みません。依頼の範囲より広げず、自分で仕事を探す時もこの基準で選びます。
- 秘密の値を画面、ログ、コミット、連絡網に書きません。
- 自治体名、本人の所属、他の参加者の名前を書きません。
- 公式 LINE の一斉送信をしません。GitHub を公開にしません。
- クロード区（/demoku/）に対して `npm run walkthrough` と `walkthrough-rest` を走らせません。
- 測っていない効果を書きません。
