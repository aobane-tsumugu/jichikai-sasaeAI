// 色と見た目を同梱し、外部への読み込み無しで使う。
export const BASE_CSS = `
/* 自治会 運営支援 — generated from tokens.json */
:root, [data-theme="light"] {
  --bg: #fbfaf6; --panel: #ffffff; --sunk: #f1efe8;
  --fg: #1a1a18; --muted: #3f3f3a;
  --accent: #14507a; --accent-strong: #0f3f61; --accent-fg: #ffffff;
  --info-bg: #e6eff6; --ok: #174f2a; --ok-bg: #e6f1e9;
  --warn: #6a4300; --warn-bg: #fbf0d9; --danger: #8f1d18; --danger-bg: #fbe9e7; --stale: #7a3400; --stale-bg: #fce8d8;
  --line: #c9c7bd; --line-strong: #6f6f68; --focus: #b34700;
}
:root {
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.5rem; --space-6: 2rem; --space-7: 3rem; --radius: 6px;
  --tap: 3rem; --tap-primary: 3.5rem; --width-text: 40rem; --width-wide: 64rem; --page-gutter: 1rem;
  --text-h1: 1.6rem; --text-h2: 1.3rem; --text-h3: 1.1rem; --text-note: 1rem; --text-button: 1.06rem; --text-count: 1.9rem;
  --font-sans: "Hiragino Sans", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, system-ui, sans-serif;
}

/* 共通の見た目。製品は Workers が HTML を返すので、部品はこの CSS とマークアップで作る。色と余白は tokens.css の変数だけを使う。 */
* { box-sizing: border-box; }
html { background: var(--bg); font-size: 112.5%; -webkit-text-size-adjust: 100%; }
@media (min-width: 60rem) { html { font-size: 125%; } }
body {
  margin: 0; container: app / inline-size;
  background: var(--bg); color: var(--fg); font-family: var(--font-sans);
  font-size: 1rem; line-height: 1.8; letter-spacing: .02em;
  line-break: strict; word-break: auto-phrase; text-wrap: pretty;
}
a { color: var(--accent); text-underline-offset: .2em; }
/* 一行で置いたリンクだけ押す面を広げ、文章の中のリンクは変えない。 */
.link-line > a, :is(h2, h3) > a, .material-links > a { display: inline-flex; align-items: center; min-height: var(--tap); }
.material-links > a { display: flex; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
p { margin: 0 0 var(--space-3); }
h1, h2, h3 { line-height: 1.45; text-wrap: balance; }
h1 { font-size: var(--text-h1); margin: var(--space-1) 0 var(--space-2); }
h2 { font-size: var(--text-h2); margin: var(--space-6) 0 var(--space-2); }
h3 { font-size: var(--text-h3); margin: var(--space-5) 0 var(--space-2); }
ul, ol { margin: 0 0 var(--space-3); padding-left: 1.4em; }

/* Layout */
header.site { background: var(--panel); border-bottom: 2px solid var(--fg); }
header.site div { max-width: var(--width-wide); margin: 0 auto; padding: var(--space-3) var(--page-gutter); display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); align-items: center; justify-content: space-between; }
header.site strong { font-size: 1.05rem; }
header.site a { display: inline-flex; align-items: center; min-height: var(--tap); font-weight: 600; }
main { max-width: var(--width-text); margin: 0 auto; padding: var(--space-3) var(--page-gutter) var(--space-7); }
main.wide { max-width: var(--width-wide); }
main:has(> .map-page) { max-width: var(--width-wide); }
.back { display: inline-flex; align-items: center; min-height: var(--tap); font-weight: 600; }
.lead { color: var(--muted); margin-bottom: var(--space-4); }
.muted { color: var(--muted); font-size: var(--text-note); }

/* Button */
button, a.button {
  display: flex; width: 100%; align-items: center; justify-content: center;
  min-height: var(--tap-primary); padding: var(--space-2) var(--space-5);
  border: 2px solid var(--accent); border-radius: var(--radius);
  background: var(--accent); color: var(--accent-fg);
  font: inherit; font-size: var(--text-button); font-weight: 700; line-height: 1.5;
  text-align: center; text-decoration: none; cursor: pointer;
}
button:hover, a.button:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
button.secondary, a.button.secondary, button.danger, a.button.danger { min-height: var(--tap); background: var(--panel); }
button.secondary, a.button.secondary { color: var(--accent); }
button.secondary:hover, a.button.secondary:hover { background: var(--info-bg); border-color: var(--accent); }
button.danger, a.button.danger { color: var(--danger); border-color: var(--danger); }
button.danger:hover, a.button.danger:hover { background: var(--danger-bg); border-color: var(--danger); }
/* 押している間は色を大きく変える。押せたかどうかを見て分かるようにする。動きは付けない */
button:active, a.button:active { background: var(--fg); border-color: var(--fg); color: var(--accent-fg); }
button.secondary:active, a.button.secondary:active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.danger:active, a.button.danger:active { background: var(--danger); border-color: var(--danger); color: var(--accent-fg); }
.action-links { display: flex; flex-direction: column; gap: var(--space-3); margin: var(--space-4) 0; }
.quiet { display: inline-flex; align-items: center; min-height: var(--tap); font-weight: 600; }
.invite-link { overflow-wrap: anywhere; word-break: break-all; }
.invite-qr { width: min(100%, 16rem); margin: var(--space-4) auto; }
.invite-qr svg { display: block; width: 100%; height: auto; }
.question-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.question-actions button.quiet { display: inline-flex; width: auto; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 1rem; text-decoration: underline; }
.question-actions button.quiet:active { background: var(--info-bg); }

/* ActionBar */
.action-bar { position: sticky; bottom: 0; z-index: 1; display: flex; flex-direction: column; gap: var(--space-2); margin: var(--space-5) calc(var(--page-gutter) * -1) calc(var(--space-7) * -1); padding: var(--space-3) var(--page-gutter) calc(var(--space-3) + env(safe-area-inset-bottom)); border-top: 2px solid var(--fg); background: var(--panel); }
/* フォーム自体が一画面目より下にある場合も、操作を下に見せる。 */
.action-bar.page-action { position: fixed; right: 0; left: 0; width: 100%; max-width: var(--width-text); margin: 0 auto; }
main:has(.page-action) { padding-bottom: calc(var(--space-7) + 7rem + env(safe-area-inset-bottom)); }

/* Notice */
.notice:empty { display: none; }
.notice { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 2px solid var(--accent); border-radius: var(--radius); background: var(--info-bg); color: var(--fg); }
.notice strong { display: block; color: var(--accent); font-weight: 700; }
.notice p { margin: 0; }
.notice.done { border-color: var(--ok); background: var(--ok-bg); }
.notice.done strong { color: var(--ok); }
.notice.warn { border-color: var(--warn); background: var(--warn-bg); }
.notice.warn strong { color: var(--warn); }
.notice.error { border-color: var(--danger); background: var(--danger-bg); }
.notice.error strong { color: var(--danger); }

/* NextStep。操作のあとに、次の行動の案を一つ出す。番号を付けず、順路にせず、押さなくても進める */
.next { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 2px solid var(--accent); border-radius: var(--radius); background: var(--panel); }
.next > strong { display: block; color: var(--accent); font-size: var(--text-h3); }
.next p { margin: 0 0 var(--space-3); }
.next > :last-child { margin-bottom: 0; }

/* Field */
.field { margin: var(--space-5) 0; }
.field label { display: block; font-weight: 700; margin-bottom: var(--space-1); }
.field .help-text { color: var(--muted); font-size: var(--text-note); margin: var(--space-1) 0 0; }
.field .error-text { color: var(--danger); font-weight: 700; margin: var(--space-1) 0 0; }
.field .warn-text { color: var(--warn); font-weight: 700; margin: var(--space-1) 0 0; }
input[type=text], input[type=password], input[type=date], input[type=number], select, textarea {
  width: 100%; min-height: var(--tap); padding: var(--space-2) var(--space-3);
  border: 2px solid var(--line-strong); border-radius: var(--radius);
  background: var(--panel); color: var(--fg); font: inherit; letter-spacing: inherit;
}
textarea { min-height: 11rem; line-height: 1.8; }

/* PeopleCount */
.qty { display: grid; gap: var(--space-2); }
.qty label { display: grid; grid-template-columns: minmax(0, 1fr) 5rem 1.2em; align-items: center; gap: var(--space-2); font-weight: 500; }
.qty input { text-align: right; }

/* FileField */
input[type=file] { width: 100%; font: inherit; color: var(--fg); }
input[type=file]::file-selector-button {
  min-height: var(--tap); margin-right: var(--space-3); padding: var(--space-2) var(--space-4);
  border: 2px solid var(--accent); border-radius: var(--radius);
  background: var(--panel); color: var(--accent); font: inherit; font-weight: 700; cursor: pointer;
}

/* 押すと何が起きるかを言葉で書く。label をボタンの形にして、入力欄を重ねる。required の欄は選ぶと色と言葉が変わる */
.file-button, .field .file-button { position: relative; display: flex; align-items: center; justify-content: center; min-height: var(--tap); margin: 0; padding: var(--space-2) var(--space-4); border: 2px solid var(--accent); border-radius: var(--radius); background: var(--panel); color: var(--accent); font-weight: 700; cursor: pointer; }
.file-button input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-button:focus-within { outline: 3px solid var(--accent); outline-offset: 3px; }
.file-button:has(input:required:valid) { border-color: var(--ok); background: var(--ok-bg); color: var(--ok); }
.file-button:has(input:required:valid)::after { content: "　選びました"; }

/* Choice */
fieldset { margin: var(--space-5) 0; padding: 0; border: 0; min-width: 0; }
legend { padding: 0; margin-bottom: var(--space-2); font-weight: 700; }
.choice { display: grid; gap: var(--space-2); }
.choice.half { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.choice label {
  display: flex; align-items: center; gap: var(--space-3); min-height: var(--tap);
  padding: var(--space-2) var(--space-3); border: 2px solid var(--line-strong); border-radius: var(--radius);
  background: var(--panel); font-weight: 500; cursor: pointer;
}
.choice input { flex: none; width: 1.4rem; height: 1.4rem; margin: 0; accent-color: var(--accent); }
.choice label:has(input:checked) { border-color: var(--accent); background: var(--info-bg); font-weight: 700; }
/* 選ぶ物の名前の下に、何のための物かと、選ぶと何が起きるかを添える */
.choice label small.muted { display: block; margin-top: var(--space-1); font-weight: 400; }

/* Hint。details で作り、JS を使わない */
details.hint { margin: var(--space-2) 0 var(--space-3); }
details.hint > summary { display: flex; align-items: center; min-height: var(--tap); color: var(--accent); font-weight: 600; text-decoration: underline; text-underline-offset: .2em; cursor: pointer; }
details.hint > div { padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--sunk); }
details.hint > div > :last-child { margin: 0; }
details.fold { margin: var(--space-3) 0; border: 2px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
details.fold > summary { display: flex; align-items: center; min-height: var(--tap); padding: var(--space-2) var(--space-3); color: var(--accent); font-weight: 700; cursor: pointer; }
details.fold > div { padding: 0 var(--space-3) var(--space-3); }

/* Panel と RowLink */
.panel { margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
.panel > :first-child { margin-top: 0; }
.panel > :last-child { margin-bottom: 0; }
.qr-image { display: block; width: 11rem; height: 11rem; margin: var(--space-3) 0; border: 1px solid var(--line-strong); background: #fff; }
.rows { display: grid; gap: var(--space-3); margin: var(--space-3) 0; padding: 0; list-style: none; }
.row-link { display: block; min-height: var(--tap); padding: var(--space-3) var(--space-4); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); color: var(--fg); text-decoration: none; }
.row-link:hover, .row-link:active { background: var(--info-bg); }
.row-link b { display: block; color: var(--accent); font-size: var(--text-h3); text-decoration: underline; text-underline-offset: .2em; }
.row-link span { display: block; color: var(--muted); font-size: var(--text-note); }

/* 短いリンクの一覧と、知らせる前に読む面 */
.photo { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
.photo-full { display: block; width: 100%; height: auto; max-height: 75vh; object-fit: contain; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
.photo-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); margin: 0 0 var(--space-3); }
.photo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4) var(--space-3); margin: var(--space-3) 0; padding: 0; list-style: none; }
.photo-grid a { display: block; color: var(--fg); text-decoration: none; }
.photo-grid b { display: block; margin-top: var(--space-1); line-height: 1.4; overflow-wrap: anywhere; }
.photo-grid span { display: block; color: var(--muted); font-size: var(--text-note); line-height: 1.4; overflow-wrap: anywhere; }
.photo-grid .photo-none { display: flex; align-items: center; min-height: 6rem; padding: var(--space-2); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); color: var(--fg); }
.received-head { display: flex; gap: var(--space-3); align-items: flex-start; }
.received-head > a { flex: 0 0 7rem; }
.received-head p { margin: 0 0 var(--space-1); line-height: 1.5; overflow-wrap: anywhere; }
h2.tight { margin-top: var(--space-3); }
.which-project fieldset { margin: var(--space-3) 0 0; padding: 0; border: 0; }
.which-project legend { padding: 0; font-weight: 700; }
.which-project .action-links { margin: var(--space-2) 0; }
details.none-of-these { margin: var(--space-2) 0; }
details.none-of-these > summary { display: flex; align-items: center; justify-content: center; min-height: var(--tap); padding: var(--space-2) var(--space-3); border: 2px solid var(--accent); border-radius: var(--radius); background: var(--panel); color: var(--accent); font-weight: 700; cursor: pointer; }
details.none-of-these > div { padding: var(--space-3) 0 0; }
.question-block + .question-block { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line); }
/* 型がこの自治会の事実に変わる: 状態は色と言葉の両方で伝える */
.state { display: inline-block; padding: 0 var(--space-2); border: 1px solid currentColor; border-radius: var(--radius); font-size: var(--text-note); font-weight: 700; line-height: 1.6; white-space: nowrap; }
.state.example { color: var(--muted); background: var(--sunk); }
.state.checking { color: var(--warn); background: var(--warn-bg); }
.state.fact { color: var(--accent); background: var(--info-bg); }
.state.old { color: var(--stale); background: var(--stale-bg); }
.state-legend { margin: var(--space-2) 0 var(--space-3); }
.state-legend .legend-title { display: block; margin-bottom: var(--space-1); }
.state-legend ul { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.state-legend li { color: var(--muted); font-size: var(--text-note); }
.state-legend li .state { margin-right: var(--space-2); }
.year-list { display: grid; gap: var(--space-2); margin: var(--space-2) 0 var(--space-3); padding: 0; list-style: none; }
.year-row { display: block; min-height: var(--tap); padding: var(--space-2) var(--space-3); border: 1px solid var(--line-strong); border-left-width: 8px; border-radius: var(--radius); background: var(--panel); color: var(--fg); text-decoration: none; }
.year-row b { display: block; line-height: 1.4; }
.year-row span.value { display: block; line-height: 1.5; }
.year-row span.note { display: block; color: var(--muted); font-size: var(--text-note); line-height: 1.5; }
.year-row.example { border-left-color: var(--line-strong); background: var(--sunk); }
.year-row.checking { border-left-color: var(--warn); background: var(--warn-bg); }
.year-row.fact { border-left-color: var(--accent); background: var(--panel); }
.year-row.old { border-left-color: var(--stale); background: var(--stale-bg); }
.year-month { margin: var(--space-4) 0 0; font-size: var(--text-h3); }
.year-month .now { margin-left: var(--space-2); color: var(--accent); font-size: var(--text-note); }
.start-count { margin: var(--space-2) 0; font-size: var(--text-h3); font-weight: 700; }
.start-bar { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 3px; margin: var(--space-2) 0 var(--space-3); }
.start-bar i { display: block; height: .75rem; border: 1px solid var(--accent); border-radius: 2px; background: var(--panel); }
.start-bar i.in { background: var(--accent); }
.year-map .map-row { min-height: var(--tap); }
.year-map .map-name { padding-top: var(--space-1); padding-bottom: var(--space-1); }
.year-map .map-name b { color: var(--fg); text-decoration: none; }
.year-map .map-row.example { background: var(--sunk); }
.year-map .map-row.example .map-name b { font-weight: 500; }
.year-map .map-row.example .map-track i { background: var(--line-strong); }
.year-map .map-row.checking { background: var(--warn-bg); }
.year-map .map-row.checking .map-track i { background: var(--warn); }
.year-map .map-row.fact { background: var(--panel); }
.year-map .map-row.fact .map-track i { background: var(--accent); }
.year-map .map-row.fact .map-track i { border: 1px solid var(--accent-strong); }
.year-map .map-row.fact.l1 .map-track i, .shade-legend i.l1 { background: #ffffff; }
.year-map .map-row.fact.l2 .map-track i, .shade-legend i.l2 { background: #c9dbea; }
.year-map .map-row.fact.l3 .map-track i, .shade-legend i.l3 { background: #8db2d2; }
.year-map .map-row.fact.l4 .map-track i, .shade-legend i.l4 { background: #4a80ad; }
.year-map .map-row.fact.l5 .map-track i, .shade-legend i.l5 { background: var(--accent-strong); }
.shade-legend { margin: 0 0 var(--space-3); }
.shade-legend p { margin: 0 0 var(--space-1); color: var(--muted); font-size: var(--text-note); }
.shade-legend ol { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: 0; padding: 0; list-style: none; font-size: var(--text-note); }
.shade-legend li { display: flex; align-items: center; gap: var(--space-1); white-space: nowrap; }
.shade-legend i { display: inline-block; width: 1.6rem; height: .8rem; border: 1px solid var(--accent-strong); }
/* 毎月の補助線。三か月ごとの線は少し濃く。狭い画面では月の数字を三か月ごとだけ出す */
.year-map .map-months span { grid-template-columns: repeat(12, 1fr); }
.year-map .map-months i { border-left-color: var(--line); }
.year-map .map-months i.q { border-left-color: var(--line-strong); }
.year-map .map-months i.q { position: relative; z-index: 1; }
.year-map .map-months i:not(.q) { color: transparent; font-weight: 500; }
.year-map .map-months i:not(.q)::first-line { background: none; }
@container app (min-width: 36rem) { .year-map .map-months i:not(.q) { color: var(--muted); } }
.year-map .map-track { background-image: linear-gradient(to right, var(--line-strong) 1px, transparent 1px), linear-gradient(to right, var(--line) 1px, transparent 1px); background-size: 25% 100%, calc(100% / 12) 100%; }
.year-map .map-row.old { background: var(--stale-bg); }
.year-map .map-row.old .map-track i { background: var(--stale); }
.links { margin: var(--space-3) 0; padding: 0; list-style: none; }
.links li { border-bottom: 1px solid var(--line); }
.links a { display: flex; align-items: center; min-height: var(--tap); font-weight: 600; }
.sheet-preview { margin: var(--space-4) 0; padding: var(--space-4); border: 1px solid var(--line-strong); background: var(--panel); }
.sheet-preview > :last-child { margin-bottom: 0; }

/* 知らせる内容を紙と住民向けのページで並べる。狭い幅では住民向けのページの面だけを出し、紙はリンクから開く */
.compare { margin: var(--space-4) 0; }
.compare .sheet-preview { margin: var(--space-2) 0 0; }
.compare-paper { display: none; }
.compare-paper .sheet-preview { border-color: var(--fg); }

.notice > button, .notice > a.button { margin-top: var(--space-2); }

/* Facts */
.facts { display: grid; grid-template-columns: 5.6em minmax(0, 1fr); gap: var(--space-2) var(--space-3); margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
.facts.long { grid-template-columns: 10em minmax(0, 1fr); }
.facts dt { color: var(--muted); font-weight: 700; }
.facts dd { margin: 0; overflow-wrap: anywhere; }

/* Count */
.counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-4) 0; }
.count { padding: var(--space-2); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
.count b { display: block; white-space: nowrap; font-size: var(--text-count); line-height: 1.25; font-variant-numeric: tabular-nums; }
.count b small { font-size: 1rem; }
.count span { display: block; color: var(--muted); font-size: var(--text-note); }

/* 進み具合の言葉 */
.tag { display: inline-block; padding: 0 var(--space-2); border: 1px solid currentColor; border-radius: var(--radius); font-size: var(--text-note); font-weight: 700; line-height: 1.7; white-space: nowrap; }
.tag.done { color: var(--ok); background: var(--ok-bg); }
.tag.now { color: var(--accent); background: var(--info-bg); }
.tag.next { color: var(--muted); background: var(--panel); }

/* MapRow。地図の一枚。月の物差しと今日の線を持つ。SVG を使わず、リストとリンクで作り、スマホでも横に動かさない */
.map { --label: 9.6rem; position: relative; margin: var(--space-4) 0; }
.map-months { position: relative; z-index: 1; display: grid; grid-template-columns: var(--label) minmax(0, 1fr); padding-top: 1.9rem; border-bottom: 2px solid var(--fg); font-size: var(--text-note); font-weight: 700; }
.map-months span { grid-column: 2; display: grid; grid-template-columns: 31fr 30fr 31fr 30fr; overflow-x: clip; }
.map-months i::first-line { background: var(--bg); }
.map-months i { padding-left: var(--space-1); border-left: 1px solid var(--line-strong); font-style: normal; white-space: nowrap; overflow-wrap: normal; }

.map-list { margin: 0; padding: 0; list-style: none; }
.map-row { display: grid; grid-template-columns: var(--label) minmax(0, 1fr); align-items: stretch; min-height: var(--tap); border-bottom: 1px solid var(--line); color: var(--fg); text-decoration: none; }
.map-row:hover, .map-row:active, .map-row.now { background: var(--info-bg); }
.map-name { padding: var(--space-2) var(--space-2) var(--space-2) var(--space-1); }
.map-name b { display: block; color: var(--accent); line-height: 1.4; text-decoration: underline; text-underline-offset: .2em; }
.map-name small { display: block; color: var(--muted); font-size: var(--text-note); line-height: 1.4; }
.map-track { position: relative; }
.map-track i { position: absolute; top: 50%; height: .8rem; margin-top: -.4rem; left: var(--from); right: calc(100% - var(--to)); min-width: .4rem; background: var(--line-strong); }
.map-row.now .map-track i { background: var(--accent); }
.map-row.done .map-track i { background: var(--ok); }
/* いま変わった行。動かさず、言葉と色で示す */
.map-row.just { background: var(--ok-bg); }
.map-name small.map-just { color: var(--ok); font-weight: 700; }
.map-today { position: absolute; top: 1.7rem; bottom: 0; left: calc(var(--label) + (100% - var(--label)) * var(--today)); width: 2px; background: var(--fg); pointer-events: none; }
.map-today span { position: absolute; top: -1.7rem; left: 1px; padding: 0 var(--space-1); background: var(--fg); color: var(--panel); font-size: var(--text-note); font-weight: 700; line-height: 1.6; white-space: nowrap; transform: translateX(-50%); }

/* Table。狭い幅では行を縦に並べ、横に動かさない */
table { width: 100%; margin: var(--space-3) 0; border-collapse: collapse; font-size: 1rem; }
.read-table { overflow-x: auto; }
.drop-zone { border: 2px dashed var(--line-strong); border-radius: 8px; padding: var(--space-3); margin: var(--space-3) 0; text-align: center; }
.drop-zone.over { background: var(--info-bg); border-color: var(--accent); }
.drop-zone p { margin: var(--space-1) 0; }
@media (pointer: coarse) { .drop-zone { display: none; } }
.read-table caption { text-align: left; color: var(--muted); font-weight: 700; }
th { padding: var(--space-2) var(--space-3); background: var(--sunk); text-align: left; }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--line); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }

/* Credentials */
.secret { padding: var(--space-2) var(--space-3); border: 2px dashed var(--accent); border-radius: var(--radius); background: var(--panel); font: 1.4rem/1.6 ui-monospace, Consolas, monospace; letter-spacing: .05em; word-break: break-all; }

/* 幅の切り替え。対応していないブラウザでは一列のまま読める */
@container app (max-width: 35.99rem) {
  table.stack thead { display: none; }
  table.stack tr { display: block; padding: var(--space-2) 0; border-bottom: 1px solid var(--line-strong); }
  table.stack td { display: grid; grid-template-columns: 6em minmax(0, 1fr); gap: var(--space-2); padding: var(--space-1) 0; border: 0; }
  table.stack td::before { content: attr(data-label); color: var(--muted); font-weight: 700; }
  table.stack .num { text-align: left; }
}
@container app (min-width: 36rem) {
  button, a.button { display: inline-flex; width: auto; min-width: 15rem; }
  .action-links { flex-direction: row; flex-wrap: wrap; align-items: center; }
  .action-bar { flex-direction: row; justify-content: flex-start; align-items: center; }
  /* 帯の文が長くても、ボタンの字を「終わ／りに／する」と縦に折らない。文の側が縮む。 */
  .action-bar > button, .action-bar > a.button { flex: 0 0 auto; white-space: nowrap; }
  .action-bar > p { flex: 1 1 auto; min-width: 0; }
  .rows.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .counts { gap: var(--space-4); }
}
@container app (min-width: 54rem) {
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: var(--space-7); align-items: start; }
  .split > aside { grid-column: 2; grid-row: 1; position: sticky; top: var(--space-4); }
  .split > section { grid-column: 1; grid-row: 1; }
  .map { --label: 19rem; }
  .compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); align-items: start; }
  .compare-paper { display: block; }
  .next { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--space-5); align-items: center; }
  .next > strong, .next > p { grid-column: 1; margin: 0; }
  .next > a.button { grid-column: 2; grid-row: 1 / span 2; }
  .compare-link { display: none; }
}

/* Sheet と AnswerSlip。A4 の紙。白黒で読め、色に頼らない */
.sheet { box-sizing: border-box; width: 210mm; min-height: 296mm; margin: 0 auto; padding: 14mm 16mm 9mm; display: flex; flex-direction: column; background: #fff; color: #000; font-size: 14pt; line-height: 1.65; }
.sheet h1 { margin: 0 0 3mm; font-size: 24pt; line-height: 1.35; }
.sheet h2 { margin: 5mm 0 2mm; font-size: 16pt; line-height: 1.35; }
.sheet p { margin: 0 0 2mm; }
.sheet table { margin: 2mm 0 3mm; }
.sheet th, .sheet td { padding: 1.2mm 2mm; border: .35mm solid #000; background: #fff; text-align: left; vertical-align: top; }
.sheet th { width: 26mm; font-weight: 700; }
.sheet-footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; margin-top: auto; padding-top: 2mm; border-top: .3mm solid #000; font-size: 9pt; }
.cut { position: relative; height: 0; margin: 6mm 0 5mm; border-top: .5mm dashed #000; text-align: center; }
.cut span { position: relative; top: -3.2mm; padding: 0 3mm; background: #fff; font-size: 10pt; }
.slip { display: flex; gap: 5mm; align-items: flex-start; }
.slip > div:first-child { flex: 1; min-width: 0; }
.field-box { margin: 0 0 2mm; padding: 1mm 2mm; border: .5mm solid #000; font-size: 12pt; font-weight: 700; }
.qr { flex: none; width: 36mm; font-size: 12pt; line-height: 1.45; text-align: center; }
.qr-box { display: flex; align-items: center; justify-content: center; width: 32mm; height: 32mm; margin: 0 auto 1mm; border: .5mm solid #000; }
.give { margin-top: 2mm; padding: 1.5mm 2.5mm; border: .7mm solid #000; font-weight: 700; }
@page { size: A4 portrait; margin: 0; }
@media print { .toolbar { display: none; } .sheet { min-height: 0; } }

/* まだ作り直していない画面にも共通の文字と幅を適用する。 */
:root { color-scheme: light; }
body { overflow-wrap: anywhere; }
main, header.site div > *, main * { min-width: 0; }
label { display: block; font-weight: 700; margin: var(--space-3) 0 var(--space-1); }
input:not([type]), input[type=email], input[type=search], input[type=url] { width: 100%; min-height: var(--tap); padding: var(--space-2) var(--space-3); border: 2px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); color: var(--fg); font: inherit; }
input, select, textarea, button, img, svg { max-width: 100%; }
/* 選ぶ欄にも本文の文字を引き継ぎ、枠の外でも指で押せる面を保つ。 */
input { font: inherit; }
input[type=radio], input[type=checkbox] { flex: none; width: 1.4rem; height: 1.4rem; margin: 0; accent-color: var(--accent); }
label:has(> input:is([type=radio], [type=checkbox])) { min-height: var(--tap); cursor: pointer; }
fieldset > label:has(> input[type=radio]) { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); border: 2px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); font-weight: 500; }
fieldset > label:has(> input:checked) { border-color: var(--accent); background: var(--info-bg); font-weight: 700; }
/* 見比べる画面は元の資料が長くても、選んだ内容を残す操作に届く。 */
main > form[action*="/questions/"] > button[name=action] { position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); z-index: 2; width: calc(100% - 2rem); max-width: var(--width-text); margin: 0 0 env(safe-area-inset-bottom); }
main:has(> form[action*="/questions/"] > button[name=action]) { padding-bottom: calc(var(--space-7) + 5rem + env(safe-area-inset-bottom)); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
form.inline { display: inline; }
details { margin: var(--space-3) 0; }
summary { min-height: var(--tap); cursor: pointer; }
details.hint { font-size: 1rem; font-weight: 400; line-height: 1.8; letter-spacing: .02em; }
.qrbox { width: 12rem; max-width: 100%; margin: var(--space-2) 0; }
.qrbox svg { display: block; width: 100%; height: auto; }
.space-photo { display: block; max-width: 100%; height: auto; margin: var(--space-4) 0; }
button.quiet { width: auto; min-width: 0; padding: var(--space-1) 0; border: 0; background: transparent; color: var(--accent); text-decoration: underline; text-align: left; }
.rows > .panel { margin: 0; }
main:has(> .rows.two) { max-width: var(--width-wide); }
@container app (min-width: 54rem) { .next > form { grid-column: 2; grid-row: 1 / span 2; } }
table { table-layout: fixed; }
th, td { overflow-wrap: anywhere; }
@media (max-width: 35.99rem) { th, td { padding: var(--space-1); } }
/* 配る確認と実行委員・班長の画面 */
main:has(.publish-confirm), main:has(.space-page) { max-width: var(--width-wide); }
.preserve-lines { white-space: pre-wrap; overflow-wrap: anywhere; }
.answer-slip-preview { border-top: 2px dashed var(--fg); padding-top: var(--space-2); }
.space-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.space-page .split > section > h2:first-child, .space-page .split > aside .action-links { margin-top: 0; }
.duty-rows { margin: var(--space-3) 0; }
main:has(.duty-rows) { max-width: var(--width-wide); }
@container app (min-width: 36rem) { .duty-rows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); } }
.duty-rows > form { margin: 0; }
.qty label:has(input[type=checkbox]) { grid-template-columns: auto minmax(0, 1fr) 5rem auto; }
.action-links > form { margin: 0; }

/* 答えと記録。小さな画面では一つずつ読める幅にする。 */
main:has(> .answers-wide), main:has(> .record-split) { max-width: var(--width-wide); }
.record-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.record-split > section, .record-split > aside { min-width: 0; }
.record-split + h2, .record-split ~ h2 { scroll-margin-top: var(--space-4); }
.print-only { display: none; }
@media (min-width: 60rem) {
  .record-split { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: var(--space-6); align-items: start; }
}
@media print {
  body:has(.answer-unanswered-print) header,
  body:has(.answer-unanswered-print) main > :not(.answer-unanswered-print) { display: none; }
  body:has(.answer-unanswered-print) main { max-width: none; padding: 0; }
  .answer-unanswered-print { color: #000; background: #fff; font-size: 14pt; line-height: 1.65; }
  .answer-unanswered-print .print-only { display: block; }
  .answer-unanswered-print section { break-inside: avoid; }
}

.answer-count-fields > div { display: grid; grid-template-columns: minmax(0, 1fr) 5rem 1.2em; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.answer-count-fields > div label { margin: 0; font-weight: 500; }
.answer-count-fields input { text-align: right; }
/* 保存欄のあとにも内容がある画面では、次の内容に重ならないようにする。 */
form > .action-bar { margin-bottom: 0; }
form.panel > .action-bar { margin-right: calc(var(--space-4) * -1); margin-left: calc(var(--space-4) * -1); margin-bottom: calc(var(--space-3) * -1); }
/* 元の資料と、台帳の補足。 */
.block { display: block; }
.original-image { display: block; width: 100%; height: auto; }
.original-document { display: block; width: 100%; height: 75vh; min-height: 24rem; border: 1px solid var(--line-strong); }
`;

export const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #d9d9d4; }
body { margin: 0; color: #000; font: 14pt/1.65 "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 8px 12px; background: #fff; border-bottom: 1px solid #888; font-size: 18px; }
.toolbar button { font: inherit; min-height: 48px; padding: 4px 18px; border: 1px solid #1f5f8b; border-radius: 6px; background: #1f5f8b; color: #fff; cursor: pointer; }
.toolbar p { margin: 0; color: #333; }
.sheet { width: 210mm; min-height: 296mm; margin: 8mm auto; padding: 14mm 16mm 10mm; background: #fff; display: flex; flex-direction: column; break-after: page; page-break-after: always; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3); }
.sheet:last-of-type { break-after: auto; page-break-after: auto; }
.sheet-body { flex: 1; min-height: 0; }
.sheet .sheet-footer { margin-top: auto; }
.sheet .float-qr { float: right; margin: 0 0 3mm 4mm; }
.sheet table { border-collapse: collapse; width: 100%; margin: 0 0 3mm; font-size: 14pt; table-layout: fixed; }
.sheet th, .sheet td { border: 0.3mm solid #000; padding: 1mm 2mm; text-align: left; vertical-align: top; }
.sheet th { width: auto; }
.sheet td, .sheet th, .sheet p { overflow-wrap: anywhere; white-space: pre-wrap; }
.sheet thead { display: table-header-group; }
.sheet tr, .field-box, .meeting-field, .qr { break-inside: avoid; page-break-inside: avoid; }
.sheet h1, .sheet h2 { break-after: avoid; }
.sheet-footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; padding-top: 2mm; border-top: 0.3mm solid #000; font-size: 9pt; }
.sheet h1 { margin: 0 0 4mm; font-size: 22pt; line-height: 1.4; }
.sheet h2 { margin: 5mm 0 2mm; font-size: 15pt; line-height: 1.4; }
.sheet p { margin: 0 0 3mm; }
.cut { position: relative; height: 0; margin: 7mm 0; border-top: 0.4mm dashed #000; text-align: center; }
.cut span { position: relative; top: -3.4mm; padding: 0 3mm; background: #fff; font-size: 9pt; }
.qr { display: inline-block; text-align: center; font-size: 12pt; line-height: 1.45; }
.qr svg { display: block; width: 100%; height: auto; }
.qr small { display: block; overflow-wrap: anywhere; }
.field-box { margin: 0 0 2mm; border: 0.4mm solid #000; padding: 1.5mm 2.5mm; }
.field-code { float: right; font: 8pt/1.2 sans-serif; }
.field-label { font-size: 12pt; font-weight: 700; }
.sheet .slip { display: flex; gap: 5mm; align-items: flex-start; break-inside: avoid; }
.sheet .answer-slip { break-inside: avoid; page-break-inside: avoid; }
.slip-fields { flex: 1; min-width: 0; }
.slip .qr { flex: none; width: 36mm; }
.slip h2 { margin-top: 0; }
.paper-code { font-size: 9pt; }
.sheet .answer-slip.standalone .paper-count { min-height: 28mm; border: .4mm solid #000; padding: 2mm; }
.sheet .give { border: .7mm solid #000; padding: 2mm; margin: 2mm 0; font-weight: 700; break-inside: avoid; }
.sheet .leader-qr { display: flex; align-items: center; gap: 6mm; padding: 4mm; font-weight: 400; }
.sheet .leader-qr .qr { flex: none; }
.sheet .paper-facts th { width: 26mm; }
.paper-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3mm; }
.paper-count { display: flex; justify-content: space-between; align-items: flex-end; gap: 1mm; min-height: 13mm; font-size: 11pt; line-height: 1.3; }
.meeting-field .field-box { flex: 1; }
.sheet .field-box p { font-size: 12pt; font-weight: 400; }
.paper-header { display: flex; justify-content: space-between; gap: 5mm; align-items: flex-start; }
.paper-header > div:first-child { flex: 1; min-width: 0; }
.paper-identity { flex: none; width: 36mm; font-size: 12pt; line-height: 1.45; text-align: center; overflow-wrap: anywhere; }
.paper-identity .qr, .paper-identity span { display: block; width: auto; margin: 0 auto; }
.sheet .paper-table { font-size: 12pt; }
.paper-duties tr, .paper-layout tr { height: 11mm; }
.paper-sponsors tr { height: 12.2mm; }
.sheet .paper-duties th:nth-child(1) { width: 47mm; }
.sheet .paper-duties th:nth-child(2) { width: 22mm; }
.sheet .paper-duties th:nth-child(3) { width: 44mm; }
.sheet .paper-duties th:nth-child(4) { width: 16mm; }
.sheet .paper-layout th:nth-child(1) { width: 48mm; }
.sheet .paper-layout th:nth-child(2) { width: 70mm; }
.sheet .paper-sponsors th:nth-child(1) { width: 36mm; }
.sheet .paper-sponsors th:nth-child(2), .sheet .paper-sponsors th:nth-child(5) { width: 27mm; }
.sheet .paper-sponsors th:nth-child(3) { width: 32mm; }
.sheet .paper-sponsors th:nth-child(4) { width: 14mm; }
.meeting-field .field-code { font-size: 12pt; line-height: 1.4; }
.toolbar > a { min-height: 48px; display: inline-flex; align-items: center; }
@media screen and (max-width: 500px) { .sheet .slip, .sheet .leader-qr, .paper-header { flex-direction: column; } .sheet table { font-size: 14pt; } .sheet .paper-table th:nth-child(n) { width: auto; } }
@page { size: A4 portrait; margin: 0; }
@media print {
  html { background: #fff; }
  .toolbar { display: none; }
  .sheet { margin: 0; min-height: 296mm; box-shadow: none; }
}
@media screen and (max-width: 215mm) {
  .sheet { width: auto; height: auto; min-height: 0; margin: 0 0 6mm; padding: 8mm 5mm; }
}
`;

export const POSTER_CSS = `
.sheet.poster { min-height:296mm; display:flex; flex-direction:column; justify-content:space-around; gap:4mm; text-align:center; padding:12mm 16mm 9mm; }
.poster h1 { margin:0; font-size:30pt; line-height:1.4; overflow-wrap:anywhere; }
.poster dl { margin:0; width:100%; }
.poster dt { margin:3mm 0 1mm; font-size:13pt; }
.poster dd { margin:0; font-size:22pt; font-weight:bold; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.poster-link { width:100%; }
.poster-qr { width:62mm; max-width:55%; margin:0 auto; }
.poster-qr svg { display:block; width:100%; height:auto; }
.poster-url { display:block; margin-top:3mm; color:#000; font-size:10pt; overflow-wrap:anywhere; }
@media screen { .poster-url { display:flex; align-items:center; justify-content:center; min-height: var(--tap); } }
@media screen and (max-width:215mm) {
  .sheet.poster { width:100%; min-height:0; aspect-ratio:210 / 296; margin:0 auto; padding:6%; gap:4vw; }
  .poster h1 { font-size:clamp(24px,7vw,40px); }
  .poster dt { margin:3vw 0 1vw; font-size:18px; }
  .poster dd { font-size:clamp(18px,5vw,28px); }
  .poster-qr { width:48%; max-width:70mm; }
  .poster-url { font-size:11px; }
}

.contact-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.contact-messages { margin-block: 1.5rem; }
`;
