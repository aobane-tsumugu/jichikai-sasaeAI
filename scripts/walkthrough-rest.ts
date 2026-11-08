// staging の役員画面と区のページを HTTP でたどり、項目ごとの結果を残す。
import { isJudgeWard, JUDGE_WARDS } from "./judge-wards.ts";
// 資格情報と作成した招待 URL は画面表示・記録に含めない。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_SLICE } from "../fixtures/first-slice.ts";

type SqlRow = Record<string, unknown>;
export interface CheckPorts {
  query: (sql: string) => Promise<SqlRow[]>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function fictionalWard(slug: string, ports: CheckPorts): Promise<string> {
  const rows = await ports.query(`SELECT ward_id, name FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ${sqlText(slug)}) AND slug = ${sqlText(slug)}`);
  const row = rows[0];
  if (rows.length !== 1 || typeof row?.ward_id !== "string" || typeof row.name !== "string" || !/試し|試験用|通し確認/.test(row.name)) throw new Error("D1で試しの区を確認できません");
  return row.ward_id;
}

// 鍵の値は取らず、line-simと同じ試験専用の設定の名前だけを照合する。
export async function checkInquiry(slug: string, ports: CheckPorts): Promise<{ result: "通過" | "飛ばす"; reason: string; status: number }> {
  const admin = "/" + encodeURIComponent(slug) + "/admin";
  const list = await ports.request(admin + "/inquiries");
  const html = await list.text();
  if (!list.ok || !html.includes("問い合わせ")) throw new Error("役員の問い合わせ一覧を開けません");
  if (html.includes("届いている問い合わせはありません")) return { result: "飛ばす", reason: `${slug}区に問い合わせの記録がありません`, status: list.status };
  const wardId = await fictionalWard(slug, ports);
  const records = await ports.query(`SELECT inquiry_id, line_source_type FROM inquiry_records WHERE ward_id = ${sqlText(wardId)} ORDER BY received_at DESC, created_at DESC, inquiry_id LIMIT 1`);
  const id = records[0]?.inquiry_id;
  if (typeof id !== "string") throw new Error("一覧に対応する問い合わせの記録を確認できません");
  // LINE由来の記録は専用設定を要する。送り先の無い記録には送る操作が出ない。
  if (records[0]?.line_source_type) {
    const channels = await ports.query(`SELECT destination, channel_secret_binding, access_token_binding FROM line_channels WHERE ward_id = ${sqlText(wardId)}`);
    if (channels.length !== 1 || channels[0]?.destination !== "U" + "0".repeat(32) || channels[0]?.channel_secret_binding !== "LINE_SIM_CHANNEL_SECRET" || channels[0]?.access_token_binding !== "LINE_SIM_CHANNEL_ACCESS_TOKEN") throw new Error("試験専用のLINE設定ではないため返事を試していません");
  }
  const path = admin + "/inquiries/" + encodeURIComponent(id);
  if (!html.includes(`href="${path}"`)) throw new Error("問い合わせ一覧から記録を開けません");
  const page = await ports.request(path);
  const detail = await page.text();
  const form = [...detail.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gi)].find(match => match[1] === path && /<textarea\b[^>]*name="answer"/.test(match[2] ?? ""));
  if (!page.ok || !form) throw new Error("問い合わせの返事の欄を確認できません");
  if (!/<button\b[^>]*name="operation"[^>]*value="send"/.test(form[2] ?? "")) throw new Error("問い合わせの返事を送る操作がありません");
  const answer = FIRST_SLICE.publicAnnouncement;
  // 失敗時も再送しない。LINE_SIMの無効な鍵で、送れない結果を見る。
  const response = await ports.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ operation: "send", answer }) });
  const result = await response.text();
  if (![400, 502].includes(response.status) || !result.includes("<h1>返事を送れませんでした</h1>") || !result.includes(answer) || !result.includes(`href="${path}"`)) throw new Error("試しの返事を送ろうとした結果と戻り先を確認できません");
  return { result: "通過", reason: "役員の一覧から問い合わせと返事の欄を開き、試しの返事が送れない結果と書いた文、戻り先を確認。実LINEへの到達は未確認", status: response.status };
}

export async function checkWorkersRoute(slug: string, projectId: string, fixtureText: string, ports: CheckPorts): Promise<void> {
  if (slug.trim().toLowerCase() === "kakuu" || isJudgeWard(slug)) throw new Error("予備経路にkakuuとdemokuとsasaedaiは使えません");
  const wardId = await fictionalWard(slug, ports);
  const w = sqlText(wardId);
  const flagSql = `SELECT use_workers_route, updated_at FROM ward_ai_route_flags WHERE ward_id = ${w}`;
  const before = await ports.query(flagSql);
  const previous = before[0];
  if (before.length > 1 || previous && (![0, 1].includes(Number(previous.use_workers_route)) || typeof previous.updated_at !== "string")) throw new Error("元の予備経路の設定を読めません");
  const updated = new Date().toISOString();
  let restored = false;
  try {
    await ports.query(`INSERT INTO ward_ai_route_flags (ward_id, use_workers_route, updated_at) VALUES (${w}, 1, ${sqlText(updated)}) ON CONFLICT (ward_id) DO UPDATE SET use_workers_route = excluded.use_workers_route, updated_at = excluded.updated_at`);
    if ((await ports.query(flagSql))[0]?.use_workers_route !== 1) throw new Error("予備経路の設定を確認できません");
    const data = new FormData();
    data.set("project_id", projectId);
    const runId = crypto.randomUUID();
    data.append("part", new Blob([fixtureText + "\n試しの予備経路の確認: " + runId], { type: "text/plain" }), "試しの予備経路_" + runId + ".txt");
    data.append("part_kind", "file");
    const sent = await ports.request("/" + encodeURIComponent(slug) + "/admin/intake", { method: "POST", headers: { accept: "application/json" }, body: data });
    const receipt: unknown = await sent.json();
    if (!sent.ok || !receipt || typeof receipt !== "object" || !("ok" in receipt) || receipt.ok !== true || !("jobId" in receipt) || typeof receipt.jobId !== "string") throw new Error("予備経路の試しの資料を新しく1件受け付けられません");
    const job = sqlText(receipt.jobId);
    const until = Date.now() + 360_000;
    do {
      const rows = await ports.query(`SELECT j.status, j.read_at, j.finished_at, j.session_id, j.stop_reason,
        (SELECT COUNT(*) FROM readings r WHERE r.ward_id = ${w} AND r.job_id = j.job_id) AS readings,
        (SELECT COUNT(*) FROM job_runs r WHERE r.ward_id = ${w} AND r.job_id = j.job_id AND r.kind = 'connect' AND r.status = 'ok' AND r.session_id = '' AND r.ended_at IS NOT NULL) AS connected
        FROM jobs j WHERE j.ward_id = ${w} AND j.job_id = ${job} AND j.project_id = ${sqlText(projectId)}`);
      const row = rows[0];
      if (rows.length !== 1 || !row) throw new Error("今回の資料の処理をD1で確認できません");
      if (["failed", "attention", "withdrawn"].includes(String(row.status))) throw new Error("予備経路の読み取りか接続が止まりました");
      if (row.status === "done") {
        if (!row.read_at || !row.finished_at || row.session_id !== null || row.stop_reason !== "end_turn" || Number(row.readings) < 1 || Number(row.connected) < 1) throw new Error("読み取りとWorkers経路での接続完了の根拠がそろいません");
        return;
      }
      await ports.sleep(3000);
    } while (Date.now() < until);
    throw new Error("6分以内に予備経路の完了を確認できませんでした");
  } finally {
    // 書き込みの応答が不明な時も元へ戻す。元の行が無ければ行自体を消す。
    try {
      if (previous) await ports.query(`UPDATE ward_ai_route_flags SET use_workers_route = ${Number(previous.use_workers_route)}, updated_at = ${sqlText(String(previous.updated_at))} WHERE ward_id = ${w}`);
      else await ports.query(`DELETE FROM ward_ai_route_flags WHERE ward_id = ${w}`);
      const after = await ports.query(flagSql);
      restored = previous ? after.length === 1 && after[0]?.use_workers_route === previous.use_workers_route && after[0]?.updated_at === previous.updated_at : after.length === 0;
    } catch { restored = false; }
    if (!restored) throw new Error("予備経路の設定を元に戻せたことを確認できません。提供側でこの自治会の設定を確認してください");
  }
}

async function queryD1(base: string, root: string, sql: string): Promise<SqlRow[]> {
  const url = new URL(base);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password || !local && url.origin !== "https://jichikai.aobane-tsumugu.com") throw new Error("D1の確認はローカルのHTTPか指定のstagingで行ってください");
  const { execFile } = await import("node:child_process");
  const output = await new Promise<string>((accept, reject) => execFile(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB", local ? "--local" : "--remote", "--json", "--command", sql],
    { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    (error, stdout) => error ? reject(new Error("D1の確認を実行できません。接続とWranglerの実行環境を確認してください")) : accept(stdout)));
  let data: unknown;
  try { data = JSON.parse(output); } catch { throw new Error("D1の応答を読めません"); }
  if (!Array.isArray(data) || data.length !== 1) throw new Error("D1の応答の形を確認できません");
  const item: unknown = data[0];
  if (!item || typeof item !== "object" || !("success" in item) || item.success !== true || !("results" in item) || !Array.isArray(item.results) || item.results.some((r: unknown) => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("D1の結果を確認できません");
  return item.results as SqlRow[];
}

async function main() {
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const ward = arg("--ward");
const baseArg = arg("--base");
const credsArg = arg("--creds");
const opsCredsArg = arg("--ops-creds");
const workersWard = arg("--workers-route-ward");
if (args.includes("--help") || !ward || !baseArg || !credsArg) {
  console.error("使い方: npm run walkthrough-rest -- --base <URL> --ward <区> --creds <役員の資格情報> [--ops-creds <運用の資格情報>] [--workers-route-ward <自治会のURL名>]\n予備経路は--wardと同じ専用の試験用の区を指定します。kakuuとdemokuは指定しないでください。D1はローカルのHTTPなら--local、指定のstagingなら--remoteで確認します。LINE由来の問い合わせの返事はLINE_SIM専用の区でだけ試します。LINE_SIMの送信の鍵はfictional-で始まる無効な値にしてください。");
  if (args.includes("--help")) return;
  process.exit(2);
}
if (args.includes("--workers-route-ward") && (!workersWard || workersWard.startsWith("--") || workersWard !== ward || ["kakuu", ...JUDGE_WARDS].includes(workersWard.toLowerCase()))) {
  console.error("--workers-route-wardは--wardと同じ専用の試験用の区を指定してください。kakuuとdemokuは使えません。");
  process.exit(2);
}
if (isJudgeWard(ward)) {
  console.error("審査員用の区では通し確認を実行しません。確認用の区を指定してください。");
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
    "# staging HTTP確認 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }), "",
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
async function post(path: string, values: Record<string, string> | URLSearchParams, timeoutMs = 30_000) {
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
    const values = new URLSearchParams();
    const body = form[2] ?? "";
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs2 = input[1] ?? "";
      if (/type="(?:checkbox|radio)"/i.test(attrs2) && !/\bchecked(?:\s|=|$)/i.test(attrs2)) continue;
      const name = /\bname="([^"]*)"/i.exec(attrs2)?.[1];
      const type = /\btype="([^"]*)"/i.exec(attrs2)?.[1];
      if (name && type !== "file" && type !== "submit") {
        const value = unescapeHtml(/\bvalue="([^"]*)"/i.exec(attrs2)?.[1] ?? "");
        fields[name] = value; values.append(name, value);
      }
    }
    for (const field of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(field[1] ?? "")?.[1];
      if (name) { fields[name] = unescapeHtml(field[2] ?? ""); values.append(name, fields[name]); }
    }
    for (const field of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(field[1] ?? "")?.[1];
      const options = [...(field[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(option => /\bselected(?:\s|=|>)/i.test(option[1] ?? "")) ?? options[0];
      if (name && selected) fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(selected[1] ?? "")?.[1] ?? selected[2] ?? "");
    }
    return { action, fields, values };
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
const sheetFilename = "試しの回答票_2班.jpg";
let opsLoggedIn = false;
let adminLoggedIn = false;
const startLogin = Date.now();
try {
  const { name, password } = credentials(credsArg);
  const login = await post(admin + "/login", /^[A-Za-z0-9._-]+$/.test(name) ? { loginId: name, password } : { name, password });
  const home = await get(admin + "/");
  if (login.status !== 303 || !cookies.has("device") || !home.response.ok) throw new Error("役員画面に入れません");
  adminLoggedIn = true;
} catch (error) {
  fail(1, "新しい行事と案内", error, startLogin);
}

// 1. 新しいプロジェクトを開いて、手書きの案内を一度配る。
if (adminLoggedIn) {
  const start = Date.now();
  try {
    const opened = await post(admin + "/projects", { kind: "event", year: String(new Date().getFullYear()) });
    projectId = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1] ?? "";
    if (opened.status !== 303 || !projectId) throw new Error("新しい行事を開けません");
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
    if (!check.ok || !checkHtml.includes("今回は自治会のLINEに送りません")) throw new Error("送らない選択の確認へ進めません");
    const final = readForm(checkHtml, "/publish/" + projectId + "/send");
    if (final.fields.lineDelivery !== "skip") throw new Error("一斉送信を止める選択がありません");
    const distributed = await post(final.action, final.fields);
    if (distributed.status !== 303) throw new Error("案内を配れません");
    const publicPage = await get(wardPath + "/p/" + projectId);
    if (!publicPage.response.ok) throw new Error("知らせた案内を開けません");
    publicLive = true;
    record(1, "新しい行事と案内", "通過", "手書きの案内を保存し、自治会のLINEを送らない選択で配布", distributed.status, start);
  } catch (error) { fail(1, "新しい行事と案内", error, start); }
} else {
  for (const [number, title] of [[2,"回答票"],[3,"今やることと区のやること"],[5,"実態の一枚"],[6,"言葉で下書きを直す"],[7,"当番表の編集"],[8,"対象者への配布"],[11,"行政の依頼と運営メモ"],[12,"元の資料を消す"],[13,"引渡し"]] as const) skip(number, title, "役員画面に入れず、前提の行事がありません");
}

// 2. 試しの回答票を読み取り、役員が確認して確定する。
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
    const page = await waitPage(answerPath + "?view=list", html => html.includes("/sheet/") && html.includes("/row/0"), html => html.includes("読めませんでした"));
    const original = /\/answers\/[^/]+\/sheet\/([^/]+)\/row\/0/.exec(page.html)?.[1];
    if (!original) throw new Error("確認できる答え行がありません");
    sheetOriginal = original;
    const rowForm = readForm(page.html, "/answers/" + projectId + "/sheet/" + original + "/row/0");
    if (!["children_count", "adults_count", "seniors_count"].every(name => name in rowForm.fields)) throw new Error("人数の内訳の欄がありません");
    if (rowForm.fields.attend !== "yes" && rowForm.fields.attend !== "no") throw new Error("回答票の出欠の印を確認できません");
    const confirmed = await post(rowForm.action, rowForm.fields);
    if (confirmed.status !== 303) throw new Error("答え行を確定できません");
    const totals = await get(answerPath);
    const answerList = await get(answerPath + "?view=list");
    if (!/参加(?:は|しないは)\d+世帯/.test(unescapeHtml(totals.html)) || !answerList.html.includes("直して入れ直す")) throw new Error("入れた返事が一覧と集計に出ません");
    record(2, "回答票", "通過", "fixturesの回答票を読み取り、確認画面から一行を確定して一覧・集計を確認", confirmed.status, start);
  } catch (error) { fail(2, "回答票", error, start); }
} else skip(2, "回答票", "配布済みの案内がなく、回答票の対象がありません");

// 3. 今やることと一年の画面で新しいプロジェクトを確認する（終わったものの一年の予定の画面は外した）。
if (projectId) {
  const start = Date.now();
  try {
    // 今やることは締切のある物だけを並べる。日付の無い行事は入口と区の段取りで見る。
    const [today, home, map] = await Promise.all([get(admin + "/projects/today"), get(admin + "/"), get(admin + "/year")]);
    if (!today.response.ok || !home.response.ok || !map.response.ok || !home.html.includes(projectTitle) || !map.html.includes(projectTitle)) throw new Error("入口と区のやることの両方に行事が見えません");
    record(3, "今やることと区のやること", "通過", "役員画面の入口と区のやることで新しい行事を確認", map.response.status, start);
  } catch (error) { fail(3, "今やることと区のやること", error, start); }
} else skip(3, "今やることと区のやること", "行事を開けませんでした");

// 4. 閉じた既存プロジェクトの検索と記録への質問。候補が無い時は記録を汚さず飛ばす。
if (!adminLoggedIn) skip(4, "全文索引と記録に聞く", "役員画面に入れず、閉じた記録を検索できません");
else {
  const start = Date.now();
  try {
    const archive = await get(admin + "/archive");
    if (!archive.response.ok || archive.html.includes("終わったものはまだありません")) {
      skip(4, "全文索引と記録に聞く", "自治会の記録に終わったものがありません");
    } else {
      const links = [...archive.html.matchAll(/href="([^"]*\/archive\/[^"/?#]+)"/g)]
        .map(match => match[1] ?? "")
        .filter(link => !/\/archive\/(?:map|search)$/.test(link));
      if (!links.length) throw new Error("閉じた記録を開けません");
      // 記録の画面は「〇〇年の動き」の下に、時期と仕事の名前を一行ずつ並べている（時期と名前は全角の空白で区切る）。動きの無い記録もある。
      let term = "";
      for (const link of links.slice(0, 40)) {
        const recordPage = await get(unescapeHtml(link));
        const mapHtml = /<h2\b[^>]*>\d{4}年の動き<\/h2>([\s\S]*?)(?=<h2\b|$)/.exec(recordPage.html)?.[1] ?? "";
        const taskNames = [...mapHtml.matchAll(/<li\b[^>]*class="panel"[^>]*>\s*<p>\s*<b>([\s\S]*?)<\/b>/g)]
          .map((match) => unescapeHtml((match[1] ?? "").replace(/<[^>]*>/g, "")).trim().split("\u3000").pop()!.trim());
        term = taskNames.find((name) => name.length >= 2) ?? "";
        if (term) break;
      }
      if (!term) throw new Error("検索語を記録から選べません");
      const search = await get(admin + "/archive/search?q=" + encodeURIComponent(term));
      if (!search.response.ok || !search.html.includes("見つかったもの") || search.html.includes("見つかりませんでした")) throw new Error("全文検索で記録が見つかりません");
      const ask = readForm(search.html, "/archive/ask");
      ask.fields.question = term + "について教えてください";
      const answer = await post(ask.action, ask.fields, 360_000);
      const answerHtml = await answer.text();
      if (!answer.ok || !answerHtml.includes("終わったものについてAIに聞く") || !answerHtml.includes("元の箇所")) throw new Error("答えと元の箇所を確認できません");
      record(4, "全文索引と記録に聞く", "通過", "閉じた記録の検索結果から元の資料へ戻り、質問の答えと根拠欄を確認", answer.status, start);
    }
  } catch (error) { fail(4, "全文索引と記録に聞く", error, start); }
}

// 5. 活動紹介を保存し、閉じた後に掲載する。後続の確認のため開き直す。
if (!projectId) skip(5, "実態の一枚", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    const path = admin + "/close/" + projectId;
    const page = await get(path + "?view=activity");
    if (!page.response.ok) throw new Error("役員の仕事を紹介する画面を開けません");
    const form = readForm(page.html, path + "/activity");
    form.fields.introduction = "会場の予約と案内を役員が受け持ちました。";
    form.fields.membershipBurden = "年に一度の当番があります。";
    form.fields.membershipBenefit = "行事の案内が届きます。";
    const taskId = /<input\b[^>]*name="taskId"[^>]*value="([^"]*)"/i.exec(page.html)?.[1];
    if (taskId) form.fields.taskId = unescapeHtml(taskId);
    form.fields.action = "save";
    const saved = await post(form.action, form.fields);
    if (saved.status !== 303 || saved.headers.get("location") !== path + "?view=activity&activity=saved") throw new Error("活動紹介の下書きを保存できません");
    const closePage = await get(path);
    const close = readForm(closePage.html, path + "/finalize");
    const closed = await post(close.action, close.values);
    if (closed.status !== 303) throw new Error("確認用の行事を閉じられません");
    try {
      const closedPage = await get(path + "?view=activity");
      const publish = readForm(closedPage.html, path + "/activity");
      publish.fields.action = "publish";
      if (taskId) publish.fields.taskId = unescapeHtml(taskId);
      const published = await post(publish.action, publish.fields);
      if (published.status !== 303 || published.headers.get("location") !== path + "?view=activity&activity=published") throw new Error("活動紹介を住民向けのページに載せられません");
      const publicPage = await get(wardPath + "/work/" + projectId);
      if (!publicPage.response.ok || !publicPage.html.includes(form.fields.introduction) || !publicPage.html.includes(form.fields.membershipBurden) || !publicPage.html.includes(form.fields.membershipBenefit)) throw new Error("載せた活動紹介を住民向けのページで確認できません");
    } finally {
      const closedPage = await get(path);
      const reopen = readForm(closedPage.html, path + "/reopen");
      const reopened = await post(reopen.action, reopen.fields);
      if (reopened.status !== 303) throw new Error("後続の確認用に行事を開き直せません");
    }
    record(5, "実態の一枚", "通過", "試しの活動紹介を保存し、閉じたあとに住民向けのページで載せる内容を確認。後続の確認用に開き直した", saved.status, start);
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
    if (queued.status !== 303) throw new Error("下書きの修正を頼めません");
    const after = await waitPage(path, html => /data-ai-status="done"/.test(html) && /<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1] !== oldText, html => /data-ai-status="(?:failed|attention)"/.test(html));
    if (!after.html.includes(FIRST_SLICE.previousPlace)) throw new Error("指示した一文を含む下書きになっていません");
    record(6, "言葉で下書きを直す", "通過", "一文の指示したあとに下書きの変化を確認", after.response.status, start);
  } catch (error) { fail(6, "言葉で下書きを直す", error, start); }
} else skip(6, "言葉で下書きを直す", "行事を開けませんでした");

// 7. 確認用の行事に試しの当番資料を入れ、その一行を編集して読み返す。
if (projectId) {
  const start = Date.now();
  try {
    const filename = "試しの当番_" + stamp + ".txt";
    const material = new FormData();
    material.set("project_id", projectId);
    material.append("part", new Blob([`${new Date().getFullYear()}年「${projectTitle}」の当番表。通し確認用の試しの資料です。\n時間帯:10:00-11:00\n持ち場:受付\n担当:確認担当\nこの内容で今年の当番を決めました。`], { type: "text/plain" }), filename);
    material.append("part_kind", "file");
    const sent = await req(admin + "/intake", { method: "POST", headers: { accept: "application/json" }, body: material });
    const receipt = await sent.json().catch(() => null) as { ok?: boolean; jobId?: string | null; duplicates?: number } | null;
    if (!sent.ok || !receipt?.ok || !receipt.jobId && !receipt.duplicates) throw new Error("試しの当番資料を送れません");
    if (receipt.jobId) {
      const state = (html: string) => { const pos = html.indexOf(filename); return pos < 0 ? "" : html.slice(pos, pos + 900); };
      await waitPage(admin + "/intake/received?project=" + encodeURIComponent(projectId),
        html => state(html).includes("どれの資料か分けました"),
        html => /読めませんでした|読み取りが遅れています/.test(state(html)));
    }
    const path = admin + "/projects/" + projectId + "/draft/duty_roster";
    // 「行事に入れました」の後に AI が行を入れるので、行が見えるまで待つ。
    const page = await waitPage(path, html => html.includes("確認担当"));
    const fixture = [...page.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].find(form => form[0].includes("/draft/duty-row/") && form[0].includes("確認担当"))?.[0];
    if (!page.response.ok || !fixture) throw new Error("試しの資料の当番の行が見えません");
    const form = readForm(fixture, "/draft/duty-row/");
    form.fields.task = (form.fields.task ?? "") + "（確認）";
    const saved = await post(form.action, form.fields);
    if (saved.status !== 303) throw new Error("当番表の行を保存できません");
    const after = await get(path);
    if (!after.response.ok || readForm(after.html, form.action).fields.task !== form.fields.task) throw new Error("当番表の編集内容が保存されていません");
    record(7, "当番表の編集", "通過", "試しの資料の当番の一行を用意し、編集して保存後の内容を読み返した", saved.status, start);
  } catch (error) { fail(7, "当番表の編集", error, start); }
} else skip(7, "当番表の編集", "行事を開けませんでした");

// 8. 名簿から一世帯を選び、配る内容の確認画面まで進む。配る操作は行わない。
if (!projectId) skip(8, "対象者への配布", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    const page = await get(admin + "/publish/" + projectId);
    if (!page.response.ok) throw new Error("配布画面を開けません");
    const entry = readForm(page.html, "/publish/" + projectId + "/confirm");
    entry.fields.lineDelivery = "skip";
    entry.fields.recipientScope = "member_households";
    let preview = await post(entry.action, entry.fields);
    if (!preview.ok) throw new Error("知らせる内容を開けません");
    let previewHtml = await preview.text();
    const firstHousehold = (html: string) => /<input\b[^>]*name="household"[^>]*value="([^"]*)"/i.exec(html)?.[1];
    if (!firstHousehold(previewHtml)) {
      const imported = await req(admin + "/answers/roster", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ rows_json: JSON.stringify([["代表者のお名前", "班"], ["確認世帯", "確認班"]]), household_column: 0, district_column: 1 }) });
      const result = await imported.json().catch(() => null) as { ok?: boolean } | null;
      if (!imported.ok || !result?.ok) throw new Error("試しの名簿を用意できません");
      preview = await post(entry.action, entry.fields);
      if (!preview.ok) throw new Error("名簿を入れたあとに知らせる内容を開けません");
      previewHtml = await preview.text();
    }
    const household = firstHousehold(previewHtml);
    if (!household) throw new Error("名簿を用意しても選べる世帯がありません");
    const form = readForm(previewHtml, "/publish/" + projectId + "/send");
    form.action = entry.action;
    form.fields.household = unescapeHtml(household);
    form.fields.targetMode = "household";
    form.fields.lineDelivery = "skip";
    const confirm = await post(form.action, form.fields);
    const html = await confirm.text();
    const target = JSON.parse(form.fields.household) as [string, string];
    if (!confirm.ok || !unescapeHtml(html).includes(target.join(" / ")) || !html.includes("今回は自治会のLINEに送りません")) throw new Error("選んだ世帯への紙の配布先を確認できません");
    record(8, "対象者への配布", "通過", "名簿を用意して一世帯を選び、紙の配布先と自治会のLINEに送らない選択を確認。配る操作は実行していない", confirm.status, start);
  } catch (error) { fail(8, "対象者への配布", error, start); }
}

const checkPorts: CheckPorts = { request: req, query: (sql) => queryD1(base, root, sql), sleep: (ms) => new Promise(done => setTimeout(done, ms)) };
// 9. 試験専用の問い合わせを役員画面で開き、返事を試した結果を見る。
if (!adminLoggedIn) skip(9, "問い合わせ", "役員画面に入れませんでした");
else
{
  const start = Date.now();
  try {
    const result = await checkInquiry(ward, checkPorts);
    record(9, "問い合わせ", result.result, result.reason, result.status, start);
  } catch (error) { fail(9, "問い合わせ", error, start); }
}

// 10. 専用の試験用の区でだけ予備経路を使い、設定の復元まで確認する。
if (!workersWard) skip(10, "予備の列", "--workers-route-ward がありません");
else if (!projectId) skip(10, "予備の列", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    await checkWorkersRoute(workersWard, projectId, FIRST_SLICE.publicAnnouncement, checkPorts);
    record(10, "予備の列", "通過", "試しの資料1件の読み取りとWorkers経路での接続完了をD1で確認し、設定を元に戻した", lastStatus, start);
  } catch (error) { fail(10, "予備の列", error, start); }
}

// 11. 行政依頼と運営メモを保存する。帳簿と決算は対象外。
if (!adminLoggedIn) skip(11, "行政の依頼と運営メモ", "役員画面に入れず、行政依頼を保存できません");
else {
  const start = Date.now();
  try {
    const opened = await post(admin + "/projects", { kind: "city_request", year: String(new Date().getFullYear()) });
    const cityId = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1];
    if (opened.status !== 303 || !cityId) throw new Error("行政の依頼行事を開けません");
    const cityPath = admin + "/requests/city/" + cityId;
    const cityPage = await get(cityPath);
    if (!cityPage.response.ok) throw new Error("行政の依頼画面を開けません");
    const cityForm = readForm(cityPage.html, "/requests/city/" + cityId);
    cityForm.fields.answerDraft = FIRST_SLICE.reportText;
    cityForm.fields.operation = "save";
    const citySaved = await post(cityForm.action, cityForm.fields);
    if (citySaved.status !== 303) throw new Error("行政の依頼を保存できません");
    const cityResultPath = citySaved.headers.get("location");
    if (!cityResultPath || !(await get(cityResultPath)).html.includes("記録しました")) throw new Error("行政の依頼を保存したあとの案内を開けません");
    const cityReadback = await get(cityPath);
    if (!cityReadback.html.includes(FIRST_SLICE.reportText)) throw new Error("行政の依頼の保存内容を読み返せません");
    const memoPath = admin + "/projects/" + cityId + "/ledger";
    const ledgerPage = await get(memoPath + "/template%3Aprinting");
    if (!ledgerPage.response.ok || !ledgerPage.html.includes("メモ")) throw new Error("運営メモを開けません");
    const ledgerForm = readForm(ledgerPage.html, "/ledger/");
    ledgerForm.fields.note = FIRST_SLICE.reportText;
    const ledgerSaved = await post(ledgerForm.action, ledgerForm.fields);
    if (ledgerSaved.status !== 303) throw new Error("運営メモを保存できません");
    const ledgerResultPath = ledgerSaved.headers.get("location");
    if (!ledgerResultPath || !(await get(ledgerResultPath)).html.includes("メモを残しました")) throw new Error("運営メモを保存したあとの案内を開けません");
    const ledgerReadback = await get(memoPath);
    if (!ledgerReadback.html.includes(FIRST_SLICE.reportText)) throw new Error("運営メモの保存内容を読み返せません");
    record(11, "行政の依頼と運営メモ", "通過", "試しの行政依頼と運営メモを保存して読み返した。提出操作なし", ledgerReadback.response.status, start);
  } catch (error) { fail(11, "行政の依頼と運営メモ", error, start); }
}

// 12. この通しの回答票の記録を「消す求め」から受け付ける。消去完了は待たない。
if (!projectId) skip(12, "元の資料を消す", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    if (!sheetOriginal) skip(12, "元の資料を消す", "この通しで受け取った回答票の元の資料がありません");
    else {
      const page = await get(admin + "/settings/deletion");
      if (!page.response.ok) throw new Error("消す求めの画面を開けません");
      const section = [...page.html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi)]
        .map(match => match[0]).find(html => unescapeHtml(html).includes(projectTitle) && unescapeHtml(html).includes(sheetFilename));
      if (!section) throw new Error("今回の行事の回答票を消す求めで選べません");
      const form = readForm(section, admin + "/settings/deletion/");
      const queued = await post(form.action, form.fields);
      const location = queued.headers.get("location");
      if (queued.status !== 303 || location !== admin + "/settings/deletion?queued=1") throw new Error("元の資料の消去を受け付けられません");
      const accepted = await get(location);
      if (!accepted.response.ok || !accepted.html.includes("消す手続きを受け付けました。")) throw new Error("元の資料の消去の受付を確認できません");
      record(12, "元の資料を消す", "通過", "今回の回答票の記録を自治会の設定の消す求めから受け付けた。消去完了は未確認", accepted.response.status, start);
    }
  } catch (error) { fail(12, "元の資料を消す", error, start); }
}

// 13. 試しの役員にリンクを渡し、本人がIDとパスワードを作る。資格情報は表示・記録しない。
if (!projectId) skip(13, "引渡し", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    const peoplePage = await get(admin + "/settings/people");
    if (!peoplePage.response.ok) throw new Error("役員の一覧を開けません");
    const testName = FIRST_SLICE.firstOfficer + " " + stamp;
    const created = await post(admin + "/settings/people/accounts", { name: testName, seatId: "" });
    const invitationHtml = await created.text();
    const invitation = unescapeHtml(/class="secret invite-link">([^<]+)<\/p>/.exec(invitationHtml)?.[1] ?? "");
    if (created.status !== 201 || !invitation) throw new Error("ログインするためのリンクを作れません");
    sensitiveValues.add(invitation);
    const invitationUrl = new URL(invitation);
    sensitiveValues.add(invitationUrl.pathname.split("/").pop()!);
    cookies.clear();
    const chosen = await post(invitationUrl.pathname + "/password", {});
    const credentialsHtml = await chosen.text();
    const loginId = unescapeHtml(/ID:\s*<strong>([^<]+)<\/strong>/.exec(credentialsHtml)?.[1] ?? "");
    const password = unescapeHtml(/<p class="secret">([^<]+)<\/p>/.exec(credentialsHtml)?.[1] ?? "");
    if (chosen.status !== 200 || !loginId || !password) throw new Error("本人のIDとパスワードを作れません");
    sensitiveValues.add(loginId);
    sensitiveValues.add(password);
    cookies.clear();
    const login = await post(admin + "/login", { loginId, password });
    const newAccountHome = await get(admin + "/");
    if (login.status !== 303 || !cookies.has("device") || !newAccountHome.response.ok) throw new Error("新しい資格で役員画面に入れません");
    record(13, "引渡し", "通過", "試しの役員にリンクを渡し、本人が作ったIDとパスワードで入る。資格値は表示・記録していない", newAccountHome.response.status, start);
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
    const numberMatch = /(?:費用|合計)[^0-9]{0,40}(?:\$|¥)?\s*[0-9][0-9,.]*/.exec(costs.html.replace(/<[^>]+>/g, " "));
    if (!numberMatch) throw new Error("費用画面に数字が見つかりません");
    record(14, "運用の費用", "通過", "運用画面の区別費用を開き、数値表示を確認", costs.response.status, start);
  } catch (error) { fail(14, "運用の費用", error, start); }
} else skip(14, "運用の費用", "--ops-credsがありません");

if (opsLoggedIn) await post("/ops/logout", {});
console.log("記録: " + evidence);
}

if (typeof process !== "undefined" && process.argv?.[1] && /(?:^|[\\/])walkthrough-rest\.ts$/.test(process.argv[1])) {
  main().catch(() => { console.error("通し確認を続けられませんでした。接続と実行環境を確認してください。"); process.exitCode = 1; });
}
