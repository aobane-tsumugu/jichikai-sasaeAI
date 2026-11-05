// staging の役員画面と区のページを HTTP でたどり、項目ごとの結果を残す。
// 資格情報と作成した招待 URL は画面表示・記録に含めない。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_SLICE } from "../fixtures/first-slice.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const ward = arg("--ward");
const baseArg = arg("--base");
const credsArg = arg("--creds");
const opsCredsArg = arg("--ops-creds");
if (!ward || !baseArg || !credsArg) {
  console.error("使い方: npm run walkthrough-rest -- --base <URL> --ward <区> --creds <役員の資格情報> [--ops-creds <運用の資格情報>]");
  process.exit(2);
}

const base = new URL(baseArg).toString().replace(/\/$/, "");
const origin = new URL(base).origin;
const wardPath = "/" + encodeURIComponent(ward);
const admin = wardPath + "/admin";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = resolve(root, "docs/EVIDENCE/walkthrough-rest-" + stamp + ".md");
mkdirSync(dirname(evidence), { recursive: true });
const rows: string[] = [];
const cookies = new Map<string, { pair: string; path: string }>();
const sensitiveValues = new Set<string>();
let lastStatus: number | null = null;

function record(number: number, title: string, result: "通過" | "止まった" | "飛ばす", reason: string, status: number | null, start: number) {
  let safe = reason;
  for (const secret of sensitiveValues) if (secret) safe = safe.replaceAll(secret, "[伏せ字]");
  safe = safe.replaceAll("|", "／").replace(/[\r\n]+/g, " ");
  rows.push(`| ${number} | ${title} | ${result} | ${safe}${status === null ? "" : `（HTTP ${status}）`} | ${Math.round((Date.now() - start) / 1000)} |`);
  writeFileSync(evidence, [
    "# staging HTTP 確認 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }), "",
    "- 区: " + ward, "- 資格情報: 値は記録していません", "- 一斉送信: 実行なし（送らない選択）", "- 本物の住民への送信: なし", "",
    "| 項目 | 確認内容 | 結果 | 理由・応答 | 秒 |", "|---:|---|---|---|---:|", ...rows, ""
  ].join("\n"), "utf8");
  console.log(`${number}: ${result}`);
}
function skip(number: number, title: string, reason: string) { record(number, title, "飛ばす", reason, null, Date.now()); }
function fail(number: number, title: string, error: unknown, start: number) {
  const reason = error instanceof Error ? error.message : "処理に失敗しました";
  record(number, title, "止まった", reason, lastStatus, start);
  process.exitCode = 1;
}
function unescapeHtml(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function req(path: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  const url = new URL(path, base + "/");
  const applicable = [...cookies.values()].filter(cookie => url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/"));
  if (applicable.length) headers.set("cookie", applicable.map(cookie => cookie.pair).join("; "));
  const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  lastStatus = response.status;
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator > 0) {
      const pathValue = /(?:^|;)\s*path=([^;]+)/i.exec(line)?.[1] ?? url.pathname;
      cookies.set(pair.slice(0, separator), { pair, path: pathValue.replace(/\/$/, "") || "/" });
    }
  }
  return response;
}
async function post(path: string, values: Record<string, string>, timeoutMs = 30_000) {
  return req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) }, timeoutMs);
}
async function get(path: string) {
  const response = await req(path);
  return { response, html: await response.text() };
}
function readForm(html: string, match: string, sectionTitle?: string) {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = form[1] ?? "";
    const action = unescapeHtml(/\baction="([^"]*)"/i.exec(attrs)?.[1] ?? "");
    if (!action.includes(match)) continue;
    const sectionStart = html.lastIndexOf("<section", form.index ?? 0);
    if (sectionTitle && !html.slice(sectionStart, form.index).includes(sectionTitle)) continue;
    const fields: Record<string, string> = {};
    const body = form[2] ?? "";
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs2 = input[1] ?? "";
      const name = /\bname="([^"]*)"/i.exec(attrs2)?.[1];
      const type = /\btype="([^"]*)"/i.exec(attrs2)?.[1];
      if (name && type !== "file" && type !== "submit" && type !== "checkbox") fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(attrs2)?.[1] ?? "");
    }
    for (const field of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(field[1] ?? "")?.[1];
      if (name) fields[name] = unescapeHtml(field[2] ?? "");
    }
    for (const field of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(field[1] ?? "")?.[1];
      const options = [...(field[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(option => /\bselected(?:\s|=|>)/i.test(option[1] ?? "")) ?? options[0];
      if (name && selected) fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(selected[1] ?? "")?.[1] ?? selected[2] ?? "");
    }
    return { action, fields };
  }
  throw new Error("必要な入力欄を画面で確認できません");
}
function credentials(path: string) {
  const content = readFileSync(resolve(path), "utf8");
  const name = /^(?:名前|氏名|ID|ログインID)\s*[:：]\s*(.+)$/m.exec(content)?.[1]?.trim();
  const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(content)?.[1]?.trim();
  if (!name || !password) throw new Error("資格情報の書式を読めません");
  sensitiveValues.add(name);
  sensitiveValues.add(password);
  return { name, password };
}
async function waitPage(path: string, done: (html: string) => boolean, failed: (html: string) => boolean = () => false) {
  const until = Date.now() + 360_000;
  let page = await get(path);
  while (Date.now() < until) {
    if (done(page.html)) return page;
    if (failed(page.html)) throw new Error("画面に処理の停止が表示されました");
    await new Promise(resolveWait => setTimeout(resolveWait, 3000));
    page = await get(path);
  }
  throw new Error("6分以内に完了を確認できませんでした");
}

let projectId = "";
let projectTitle = "";
let publicLive = false;
let sheetOriginal = "";
const sheetFilename = "架空の回答票_2班.jpg";
let opsLoggedIn = false;
let adminLoggedIn = false;
const startLogin = Date.now();
try {
  const { name, password } = credentials(credsArg);
  const login = await post(admin + "/login", { name, password });
  const home = await get(admin + "/");
  if (login.status !== 303 || !cookies.has("device") || !home.response.ok) throw new Error("役員画面に入れません");
  adminLoggedIn = true;
} catch (error) {
  fail(1, "新しいプロジェクトと案内", error, startLogin);
}

// 1. 新しいプロジェクトを開いて、手書きの案内を一度配る。
if (adminLoggedIn) {
  const start = Date.now();
  try {
    const opened = await post(admin + "/projects", { kind: "event", year: String(new Date().getFullYear()) });
    projectId = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1] ?? "";
    if (opened.status !== 303 || !projectId) throw new Error("新しいプロジェクトを開けません");
    projectTitle = FIRST_SLICE.draftTitle + " " + stamp.slice(0, 13);
    const renamed = await post(admin + "/projects/" + projectId + "/title", { title: projectTitle });
    if (renamed.status !== 303) throw new Error("題を保存できません");
    const draftPath = admin + "/projects/" + projectId + "/draft/announcement";
    const draftPage = await get(draftPath);
    const draft = readForm(draftPage.html, "/draft/announcement/save");
    draft.fields.text = FIRST_SLICE.publicAnnouncement;
    const saved = await post(draft.action, draft.fields);
    if (saved.status !== 303) throw new Error("手書きの案内を保存できません");
    const publishPage = await get(admin + "/publish/" + projectId);
    const confirm = readForm(publishPage.html, "/publish/" + projectId + "/confirm");
    confirm.fields.lineDelivery = "skip";
    const check = await post(confirm.action, confirm.fields);
    const checkHtml = await check.text();
    if (!check.ok || !checkHtml.includes("今回は公式 LINE に送りません")) throw new Error("送らない選択の確認へ進めません");
    const final = readForm(checkHtml, "/publish/" + projectId + "/send");
    if (final.fields.lineDelivery !== "skip") throw new Error("一斉送信を止める選択がありません");
    const distributed = await post(final.action, final.fields);
    if (distributed.status !== 303) throw new Error("案内を配れません");
    const publicPage = await get(wardPath + "/p/" + projectId);
    if (!publicPage.response.ok) throw new Error("配った案内を開けません");
    publicLive = true;
    record(1, "新しいプロジェクトと案内", "通過", "手書きの案内を保存し、公式 LINE を送らない選択で配布", distributed.status, start);
  } catch (error) { fail(1, "新しいプロジェクトと案内", error, start); }
} else {
  for (const [number, title] of [[2,"回答票"],[3,"今やることと区の地図"],[5,"実態の一枚"],[6,"言葉で案を直す"],[7,"当番表の編集"],[8,"対象者への配布"],[10,"予備の列"],[11,"行政の依頼と帳簿"],[12,"原本を消す"],[13,"引渡し"]] as const) skip(number, title, "役員画面に入れず、前提のプロジェクトがありません");
}

// 2. 架空の回答票を読み取り、役員が確認して確定する。
if (projectId && publicLive) {
  const start = Date.now();
  try {
    const fixture = resolve(root, "fixtures/this-year/answers/回答票_2班.jpg");
    const bytes = readFileSync(fixture);
    const form = new FormData();
    form.append("part", new Blob([bytes], { type: "image/jpeg" }), sheetFilename);
    form.append("text", ""); form.append("project_id", projectId);
    const sent = await req(admin + "/answers/" + projectId + "/sheet", { method: "POST", body: form });
    if (sent.status !== 303) throw new Error("回答票を送れません");
    const answerPath = admin + "/answers/" + projectId;
    const page = await waitPage(answerPath, html => html.includes("回答票の読み取り") && /name="household"/.test(html), html => html.includes("読めませんでした"));
    const original = /\/answers\/[^/]+\/sheet\/([^/]+)\/row\/0/.exec(page.html)?.[1];
    if (!original) throw new Error("確認できる回答行がありません");
    sheetOriginal = original;
    const rowForm = readForm(page.html, "/answers/" + projectId + "/sheet/" + original + "/row/0");
    const confirmed = await post(rowForm.action, rowForm.fields);
    if (confirmed.status !== 303) throw new Error("回答行を確定できません");
    const totals = await get(answerPath);
    if (!totals.html.includes("参加人数:") || !totals.html.includes("回答票")) throw new Error("確定した回答が一覧と集計に出ません");
    record(2, "回答票", "通過", "fixtures の回答票を読み取り、確認画面から一行を確定して一覧・集計を確認", confirmed.status, start);
  } catch (error) { fail(2, "回答票", error, start); }
} else skip(2, "回答票", "配布済みの案内がなく、回答票の対象がありません");

// 3. 今やることと区の地図で新しいプロジェクトを確認する。
if (projectId) {
  const start = Date.now();
  try {
    const [today, map] = await Promise.all([get(admin + "/projects/today"), get(admin + "/archive/map")]);
    if (!today.response.ok || !map.response.ok || !today.html.includes(projectTitle) || !map.html.includes(projectTitle)) throw new Error("今やることと区の地図の両方にプロジェクトが見えません");
    record(3, "今やることと区の地図", "通過", "役員画面の入口と区の地図で新しいプロジェクトを確認", map.response.status, start);
  } catch (error) { fail(3, "今やることと区の地図", error, start); }
} else skip(3, "今やることと区の地図", "プロジェクトを開けませんでした");

// 4. 閉じた既存プロジェクトの検索と記録への質問。候補が無い時は記録を汚さず飛ばす。
if (!adminLoggedIn) skip(4, "全文索引と記録に聞く", "役員画面に入れず、閉じた記録を検索できません");
else {
  const start = Date.now();
  try {
    const archive = await get(admin + "/archive");
    if (!archive.response.ok || archive.html.includes("閉じたプロジェクトはまだありません")) {
      skip(4, "全文索引と記録に聞く", "区の記録に閉じたプロジェクトがありません");
    } else {
      const firstLink = [...archive.html.matchAll(/href="([^"]*\/archive\/[^"/?#]+)"/g)]
        .map(match => match[1] ?? "")
        .find(link => !/\/archive\/(?:map|search)$/.test(link));
      if (!firstLink) throw new Error("閉じた記録を開けません");
      const recordPage = await get(unescapeHtml(firstLink));
      const mapHtml = /<h2>地図<\/h2>([\s\S]*?)<h2>報告<\/h2>/.exec(recordPage.html)?.[1] ?? "";
      const term = unescapeHtml(/<h3>([^<]{3,})<\/h3>/.exec(mapHtml)?.[1] ?? "").trim();
      if (!term) throw new Error("検索語を記録から選べません");
      const search = await get(admin + "/archive/search?q=" + encodeURIComponent(term));
      if (!search.response.ok || !search.html.includes("元の箇所へ戻る")) throw new Error("全文検索から元の箇所へ戻れません");
      const ask = readForm(search.html, "/archive/ask");
      ask.fields.question = term + "について教えてください";
      const answer = await post(ask.action, ask.fields, 360_000);
      const answerHtml = await answer.text();
      if (!answer.ok || !answerHtml.includes("記録に聞く") || !answerHtml.includes("元の箇所")) throw new Error("答えと元の箇所を確認できません");
      record(4, "全文索引と記録に聞く", "通過", "閉じた記録の検索結果から原本へ戻り、質問の答えと根拠欄を確認", answer.status, start);
    }
  } catch (error) { fail(4, "全文索引と記録に聞く", error, start); }
}

// 5. 「実態の一枚」の公開・印刷画面がある場合に確認する。
if (!projectId) skip(5, "実態の一枚", "前提のプロジェクトを開けませんでした");
else {
  const start = Date.now();
  try {
    const page = await get(admin + "/projects/" + projectId);
    const link = /href="([^"]*\/activity[^"]*)"/.exec(page.html)?.[1];
    if (!link) skip(5, "実態の一枚", "役員画面に実態の一枚を作る入口がありません");
    else {
      const activity = await get(unescapeHtml(link));
      if (!activity.response.ok) throw new Error("実態の一枚を開けません");
      const form = readForm(activity.html, "/activity");
      const saved = await post(form.action, form.fields);
      if (saved.status !== 303) throw new Error("実態の一枚を保存・配布できません");
      record(5, "実態の一枚", "通過", "画面を開き、表示された内容で保存", saved.status, start);
    }
  } catch (error) { fail(5, "実態の一枚", error, start); }
}

// 6. AI に短い指示を出し、案の変化を最大6分待つ。
if (projectId) {
  const start = Date.now();
  try {
    const path = admin + "/projects/" + projectId + "/draft/announcement";
    const before = await get(path);
    const oldText = /<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/i.exec(before.html)?.[1] ?? "";
    const form = readForm(before.html, "/draft/announcement/start");
    form.fields.instruction = "本文に『集合場所は" + FIRST_SLICE.previousPlace + "です』を一文加えてください。";
    const queued = await post(form.action, form.fields);
    if (queued.status !== 303) throw new Error("案の修正を頼めません");
    const after = await waitPage(path, html => /data-ai-status="done"/.test(html) && /<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1] !== oldText, html => /data-ai-status="(?:failed|attention)"/.test(html));
    if (!after.html.includes(FIRST_SLICE.previousPlace)) throw new Error("指示した一文を含む案になっていません");
    record(6, "言葉で案を直す", "通過", "一文の指示後に案の変化を確認", after.response.status, start);
  } catch (error) { fail(6, "言葉で案を直す", error, start); }
} else skip(6, "言葉で案を直す", "プロジェクトを開けませんでした");

// 7. 当番表の一行があれば編集して保存する。
if (projectId) {
  const start = Date.now();
  try {
    const path = admin + "/projects/" + projectId + "/draft/duty_roster";
    const page = await get(path);
    const rowAction = /action="([^"]*\/draft\/duty-row\/[^\"]+)"/.exec(page.html)?.[1];
    if (!rowAction) skip(7, "当番表の編集", "当番表に編集できる行がありません");
    else {
      const form = readForm(page.html, "/draft/duty-row/");
      form.fields.task = (form.fields.task ?? "") + "（確認）";
      const saved = await post(form.action, form.fields);
      if (saved.status !== 303) throw new Error("当番表の行を保存できません");
      record(7, "当番表の編集", "通過", "既存の一行を編集して保存", saved.status, start);
    }
  } catch (error) { fail(7, "当番表の編集", error, start); }
} else skip(7, "当番表の編集", "プロジェクトを開けませんでした");

// 8. 名簿を選んだ一部だけに配る画面があるかを確認。全体配布は行わない。
if (!projectId) skip(8, "対象者への配布", "前提のプロジェクトを開けませんでした");
else {
  const start = Date.now();
  try {
    const page = await get(admin + "/publish/" + projectId);
    if (!page.response.ok) throw new Error("配布画面を開けません");
    if (!/name="(?:households|recipients|target_households)"/.test(page.html)) skip(8, "対象者への配布", "配布画面に対象世帯を一部選ぶ欄がなく、送信操作は実行しません");
    else skip(8, "対象者への配布", "対象世帯の指定はありますが、本物の住民に送らないため配布は実行しません");
  } catch (error) { fail(8, "対象者への配布", error, start); }
}

// 9. 住民からの問い合わせ入口が提供されているか確認する。LINE 署名が要る経路は使わない。
{
  const start = Date.now();
  try {
    const wardPage = await get(wardPath + "/");
    if (/action="[^"]*(?:inquir|contact|request)/i.test(wardPage.html)) skip(9, "問い合わせ", "住民向けの HTTP 問い合わせ入口を画面で確認できません（LINE 署名が要る経路は対象外）");
    else skip(9, "問い合わせ", "住民向け問い合わせ画面がありません。役員の記録フォームは住民側の入口ではありません");
  } catch (error) { fail(9, "問い合わせ", error, start); }
}

// 10. 専用の予備経路画面がある場合だけ開く。通常の手入力欄とは区別する。
if (!projectId) skip(10, "予備の列", "前提のプロジェクトを開けませんでした");
else skip(10, "予備の列", "役員画面に予備経路の専用画面はなく、通常の手入力画面だけです");

// 11. 行政依頼・帳簿の入力画面を読み、未提出のまま保存する。
if (!adminLoggedIn) skip(11, "行政の依頼と帳簿", "役員画面に入れず、行政依頼を保存できません");
else {
  const start = Date.now();
  try {
    const opened = await post(admin + "/projects", { kind: "city_request", year: String(new Date().getFullYear()) });
    const cityId = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1];
    if (opened.status !== 303 || !cityId) throw new Error("行政の依頼プロジェクトを開けません");
    const cityPath = admin + "/requests/city/" + cityId;
    const cityPage = await get(cityPath);
    if (!cityPage.response.ok) throw new Error("行政の依頼画面を開けません");
    const cityForm = readForm(cityPage.html, "/requests/city/" + cityId);
    cityForm.fields.answerDraft = FIRST_SLICE.reportText;
    cityForm.fields.operation = "save";
    const citySaved = await post(cityForm.action, cityForm.fields);
    if (citySaved.status !== 303) throw new Error("行政の依頼を保存できません");
    const cityReadback = await get(cityPath);
    if (!cityReadback.html.includes(FIRST_SLICE.reportText)) throw new Error("行政の依頼の保存内容を読み返せません");
    const ledgerPage = await get(admin + "/ledger");
    if (!ledgerPage.response.ok || !ledgerPage.html.includes("帳簿")) throw new Error("帳簿を開けません");
    const ledgerForm = readForm(ledgerPage.html, "/ledger");
    ledgerForm.fields.settlementDraft = FIRST_SLICE.reportText;
    const ledgerSaved = await post(ledgerForm.action, ledgerForm.fields);
    if (ledgerSaved.status !== 303) throw new Error("帳簿を保存できません");
    const ledgerReadback = await get(admin + "/ledger");
    if (!ledgerReadback.html.includes(FIRST_SLICE.reportText)) throw new Error("帳簿の保存内容を読み返せません");
    record(11, "行政の依頼と帳簿", "通過", "架空の行政依頼と帳簿の下書きを保存し、帳簿を読み返した。提出操作なし", ledgerReadback.response.status, start);
  } catch (error) { fail(11, "行政の依頼と帳簿", error, start); }
}

// 12. 新しいプロジェクトの原本を消す機能があれば、公開と記録からの削除を確かめる。
if (!projectId) skip(12, "原本を消す", "前提のプロジェクトを開けませんでした");
else {
  const start = Date.now();
  try {
    const intake = await get(admin + "/intake?project=" + encodeURIComponent(projectId));
    const originalId = sheetOriginal;
    const withdrawAction = /<form\b[^>]*action="([^"]*\/intake\/[^/"?]+\/withdraw)"[^>]*>/i.exec(intake.html)?.[1];
    if (!originalId || !withdrawAction) skip(12, "原本を消す", "新しいプロジェクトの回答票が取り下げ可能な状態ではありません");
    else {
      const originalPage = await get(admin + "/intake/originals/" + originalId);
      if (!originalPage.response.ok) throw new Error("原本を開けません");
      const removed = await post(unescapeHtml(withdrawAction), {});
      if (removed.status !== 303) throw new Error("原本を取り下げられません");
      const [publicPage, originalAfter, recordPage] = await Promise.all([get(wardPath + "/p/" + projectId), get(admin + "/intake/originals/" + originalId), get(admin + "/projects/" + projectId)]);
      if (!publicPage.response.ok || publicPage.html.includes(sheetFilename) || originalAfter.response.status !== 404 || recordPage.html.includes("/intake/originals/" + originalId)) throw new Error("公開側または記録から原本が見えなくなったことを確認できません");
      record(12, "原本を消す", "通過", "原本と読み取りを取り下げ、原本が開けず、公開案内にファイル名がなく、記録に原本リンクがないことを確認", removed.status, start);
    }
  } catch (error) { fail(12, "原本を消す", error, start); }
}

// 13. 架空の役員アカウントを足し、新しい資格でログインする。資格情報は表示・記録しない。
if (!projectId) skip(13, "引渡し", "前提のプロジェクトを開けませんでした");
else {
  const start = Date.now();
  try {
    const peoplePage = await get(admin + "/settings/people");
    if (!peoplePage.response.ok) throw new Error("役員の席とアカウントを開けません");
    const form = readForm(peoplePage.html, "/accounts");
    const testName = FIRST_SLICE.firstOfficer + " " + stamp.slice(0, 12);
    form.fields.name = testName;
    const created = await post(form.action, form.fields);
    const credentialsHtml = await created.text();
    const loginId = unescapeHtml(/ID:\s*<strong>([^<]+)<\/strong>/.exec(credentialsHtml)?.[1] ?? "");
    const password = unescapeHtml(/<p class="secret">([^<]+)<\/p>/.exec(credentialsHtml)?.[1] ?? "");
    if (created.status !== 201 || !loginId || !password) throw new Error("新しい役員資格を作れません");
    sensitiveValues.add(loginId);
    sensitiveValues.add(password);
    cookies.clear();
    const login = await post(admin + "/login", { loginId, password });
    const newAccountHome = await get(admin + "/");
    if (login.status !== 303 || !cookies.has("device") || !newAccountHome.response.ok || !newAccountHome.html.includes(testName)) throw new Error("新しい資格で役員画面に入れません");
    record(13, "引渡し", "通過", "架空の役員アカウントを足し、新しい資格でログイン。資格値は表示・記録していない", newAccountHome.response.status, start);
  } catch (error) { fail(13, "引渡し", error, start); }
}

// 14. 運用資格が渡された場合だけ費用画面を開く。
if (opsCredsArg) {
  const start = Date.now();
  try {
    cookies.clear();
    const { name, password } = credentials(opsCredsArg);
    const login = await post("/ops/login", { id: name, password });
    const home = await get("/ops/");
    if (login.status !== 303 || !home.response.ok) throw new Error("運用の画面に入れません");
    opsLoggedIn = true;
    const costs = await get("/ops/wards/" + encodeURIComponent(ward) + "/costs");
    if (!costs.response.ok || !/費用|\$|円|USD|入力\s*\d/.test(costs.html)) throw new Error("費用の画面または数字を確認できません");
    const numberMatch = /(?:費用|合計)[^<]{0,40}(?:\$|¥)?\s*[0-9][0-9,.]*/.exec(costs.html);
    if (!numberMatch) throw new Error("費用画面に数字が見つかりません");
    record(14, "運用の費用", "通過", "運用画面の区別費用を開き、数値表示を確認", costs.response.status, start);
  } catch (error) { fail(14, "運用の費用", error, start); }
} else skip(14, "運用の費用", "--ops-creds がありません");

if (opsLoggedIn) await post("/ops/logout", {});
console.log("記録: " + evidence);
