// 色と見た目を同梱し、外部への読み込み無しで使う。
export const BASE_CSS = `
/* 自治会 運営支援 — generated from tokens.json */
:root, [data-theme="light"] {
  --bg: #fbfaf6; --panel: #ffffff; --sunk: #f1efe8;
  --fg: #1a1a18; --muted: #3f3f3a;
  --accent: #14507a; --accent-strong: #0f3f61; --accent-fg: #ffffff;
  --info-bg: #e6eff6; --ok: #174f2a; --ok-bg: #e6f1e9;
  --warn: #6a4300; --warn-bg: #fbf0d9; --danger: #8f1d18; --danger-bg: #fbe9e7;
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

/* ActionBar */
.action-bar { position: sticky; bottom: 0; z-index: 1; display: flex; flex-direction: column; gap: var(--space-2); margin: var(--space-5) calc(var(--page-gutter) * -1) calc(var(--space-7) * -1); padding: var(--space-3) var(--page-gutter) calc(var(--space-3) + env(safe-area-inset-bottom)); border-top: 2px solid var(--fg); background: var(--panel); }

/* Notice */
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
.panel > :last-child { margin-bottom: 0; }
.rows { display: grid; gap: var(--space-3); margin: var(--space-3) 0; padding: 0; list-style: none; }
.row-link { display: block; min-height: var(--tap); padding: var(--space-3) var(--space-4); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); color: var(--fg); text-decoration: none; }
.row-link:hover, .row-link:active { background: var(--info-bg); }
.row-link b { display: block; color: var(--accent); font-size: var(--text-h3); text-decoration: underline; text-underline-offset: .2em; }
.row-link span { display: block; color: var(--muted); font-size: var(--text-note); }

/* 短いリンクの一覧と、配る前に読む面 */
.links { margin: var(--space-3) 0; padding: 0; list-style: none; }
.links li { border-bottom: 1px solid var(--line); }
.links a { display: flex; align-items: center; min-height: var(--tap); font-weight: 600; }
.sheet-preview { margin: var(--space-4) 0; padding: var(--space-4); border: 1px solid var(--line-strong); background: var(--panel); }
.sheet-preview > :last-child { margin-bottom: 0; }

/* 配る内容を紙と区のページで並べる。狭い幅では区のページの面だけを出し、紙はリンクから開く */
.compare { margin: var(--space-4) 0; }
.compare .sheet-preview { margin: var(--space-2) 0 0; }
.compare-paper { display: none; }
.compare-paper .sheet-preview { border-color: var(--fg); }

.notice > button, .notice > a.button { margin-top: var(--space-2); }

/* Facts */
.facts { display: grid; grid-template-columns: 5.6em minmax(0, 1fr); gap: var(--space-2) var(--space-3); margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); }
.facts dt { color: var(--muted); font-weight: 700; }
.facts dd { margin: 0; }

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
.map-months span { grid-column: 2; display: grid; grid-template-columns: 31fr 30fr 31fr 30fr; }
.map-months i::first-line { background: var(--bg); }
.map-months i { padding-left: var(--space-1); border-left: 1px solid var(--line-strong); font-style: normal; white-space: nowrap; }
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
table { width: 100%; margin: var(--space-3) 0; border-collapse: collapse; }
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
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
form.inline { display: inline; }
details { margin: var(--space-3) 0; }
summary { min-height: var(--tap); cursor: pointer; }
details.hint { font-size: 1rem; font-weight: 400; line-height: 1.8; letter-spacing: .02em; }
.qrbox { width: 12rem; max-width: 100%; margin: var(--space-2) 0; }
.qrbox svg { display: block; width: 100%; height: auto; }
table { table-layout: fixed; }
th, td { overflow-wrap: anywhere; }
@media (max-width: 35.99rem) { th, td { padding: var(--space-1); } }
/* 配る確認と実行委員・班長の画面 */
main:has(.publish-confirm), main:has(.space-page) { max-width: var(--width-wide); }
.preserve-lines { white-space: pre-wrap; overflow-wrap: anywhere; }
.answer-slip-preview { border-top: 2px dashed var(--fg); padding-top: var(--space-2); }
.space-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.qty label:has(input[type=checkbox]) { grid-template-columns: auto minmax(0, 1fr) 5rem auto; }
.action-links > form { margin: 0; }
`;
