// 架空の区専用。送るのは署名付きの受信要求だけで、LINEの送信APIは呼ばない。
export type SqlRow = Record<string, unknown>;
export type Query = (sql: string) => Promise<SqlRow[]>;
export type Expected = { kind: "答えに数える" | "資料に入る" | "残さない" | "問い合わせ"; household?: string; district?: string; people?: number };
export interface Scene {
  id: string;
  category: string;
  talk: string;
  group: boolean;
  messages: Array<{ text: string; expected: Expected }>;
}
export interface Scenes {
  fictional: true;
  notice: string;
  projectTitle: string;
  roster: Array<{ household: string; district: string }>;
  scenes: Scene[];
}
export interface SimOptions {
  base: string;
  ward: string;
  wardId: string;
  destination: string;
  secret: string;
  accessToken: string;
  remote: boolean;
  waitMs: number;
}
export interface SimPorts {
  query: Query;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  record: (report: string) => Promise<void>;
}
export class SimError extends Error {}
function fail(message: string): never { throw new SimError(message); }
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function validateTarget(options: SimOptions): URL {
  if (options.ward.trim().toLowerCase() === "demoku" || options.wardId.trim().toLowerCase() === "demoku") fail("demokuには送れません。");
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(options.ward) || !/^[a-zA-Z0-9_-]{1,100}$/.test(options.wardId)) fail("区の指定を確認してください。");
  let base: URL;
  try { base = new URL(options.base); } catch { return fail("--baseにURLを指定してください。"); }
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) fail("--baseにはサイトの先頭のURLを指定してください。");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (options.remote ? base.origin !== "https://jichikai.aobane-tsumugu.com" : !local || base.protocol !== "http:") fail("ローカルのHTTPか、--remoteを付けた指定のstagingを使ってください。");
  if (!/^U0{32}$/.test(options.destination)) fail("架空専用のLINE_SIM_DESTINATIONを指定してください。");
  if (!options.secret || !options.accessToken.startsWith("fictional-")) fail("架空のLINE_SIM_CHANNEL_SECRETと、fictional-で始まるLINE_SIM_CHANNEL_ACCESS_TOKENを環境変数に設定してください。");
  if (!Number.isInteger(options.waitMs) || options.waitMs < 1000 || options.waitMs > 120000) fail("--wait-msは1000から120000までです。");
  return base;
}

export function parseScenes(value: unknown): Scenes {
  if (!value || typeof value !== "object" || !("fictional" in value) || value.fictional !== true || !("notice" in value) || typeof value.notice !== "string" || !value.notice.includes("架空") || !("projectTitle" in value) || typeof value.projectTitle !== "string" || !value.projectTitle.includes("架空") || !("scenes" in value) || !Array.isArray(value.scenes) || !value.scenes.length || !("roster" in value) || !Array.isArray(value.roster) || !value.roster.length) fail("架空と明記した場面と名簿が必要です。");
  const data = value as Scenes;
  const ids = new Set<string>();
  for (const scene of data.scenes) {
    if (!scene || typeof scene.id !== "string" || !/^[a-z0-9-]+$/.test(scene.id) || ids.has(scene.id) || typeof scene.category !== "string" || typeof scene.talk !== "string" || !/^[a-z0-9-]+$/.test(scene.talk) || typeof scene.group !== "boolean" || !Array.isArray(scene.messages) || !scene.messages.length) fail("場面の番号、場所、文を確認してください。");
    ids.add(scene.id);
    for (const message of scene.messages) {
      if (typeof message.text !== "string" || !message.text.trim() || !message.expected || !["答えに数える", "資料に入る", "残さない", "問い合わせ"].includes(message.expected.kind)) fail("各文に期待する結果を書いてください。");
      if (message.expected.kind === "答えに数える" && (typeof message.expected.household !== "string" || typeof message.expected.district !== "string" || !Number.isInteger(message.expected.people) || message.expected.people! < 0)) fail("答えには名前、班、人数の期待を書いてください。");
    }
  }
  for (const entry of data.roster) if (!entry || typeof entry.household !== "string" || typeof entry.district !== "string" || !entry.household.includes("架空")) fail("名簿には架空の名前と班が必要です。");
  return data;
}

export async function signedWebhook(destination: string, secret: string, eventId: string, talk: string, group: boolean, text: string, at: number): Promise<{ body: string; signature: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(talk)));
  const id = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: eventId, timestamp: at,
    deliveryContext: { isRedelivery: false }, replyToken: `fictional-reply-${eventId}`,
    source: group ? { type: "group", groupId: `C${id}`, userId: `U${id}` } : { type: "user", userId: `U${id}` },
    message: { type: "text", id: String(at), text } }] });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
  return { body, signature };
}

export function preflightSql(options: SimOptions, title: string): string {
  return `SELECT w.slug, w.name, c.channel_secret_binding, c.access_token_binding, p.project_id,
    (SELECT COUNT(*) FROM project_answers a WHERE a.ward_id = w.ward_id AND a.project_id = p.project_id) AS prior_answers
    FROM wards w JOIN line_channels c ON c.ward_id = w.ward_id
    JOIN projects p ON p.ward_id = w.ward_id
    WHERE w.ward_id = ${sqlText(options.wardId)} AND c.ward_id = ${sqlText(options.wardId)} AND p.ward_id = ${sqlText(options.wardId)}
    AND w.slug = ${sqlText(options.ward)} AND c.destination = ${sqlText(options.destination)} AND p.title = ${sqlText(title)} AND p.closed_at IS NULL`;
}

export function observationSql(wardId: string, eventId: string): string {
  const ward = sqlText(wardId), event = sqlText(eventId);
  return `SELECT
    (SELECT COUNT(*) FROM line_webhook_receipts WHERE ward_id = ${ward} AND event_id = ${event}) AS receipt,
    (SELECT COUNT(*) FROM inquiry_records WHERE ward_id = ${ward} AND line_event_id = ${event}) AS inquiries,
    (SELECT COUNT(*) FROM inquiry_records WHERE ward_id = ${ward} AND line_event_id = ${event} AND line_replied_at IS NOT NULL) AS replied,
    i.item_id, i.matched_project_id, i.disposition, j.project_id AS job_project_id, j.status,
    o.original_id, a.answer_id, a.project_id AS answer_project_id, a.household, a.district, a.people_count
    FROM (SELECT 1) anchor LEFT JOIN line_inbox_items i ON i.ward_id = ${ward} AND i.event_id = ${event}
    LEFT JOIN jobs j ON j.ward_id = ${ward} AND j.job_id = i.job_id
    LEFT JOIN originals o ON o.ward_id = ${ward} AND o.job_id = j.job_id AND o.withdrawn_at IS NULL
    LEFT JOIN project_answers a ON a.ward_id = ${ward} AND a.original_id = o.original_id`;
}

function unrelatedSql(wardId: string, day: string): string {
  return `SELECT COALESCE((SELECT item_count FROM line_unrelated_daily_counts WHERE ward_id = ${sqlText(wardId)} AND day = ${sqlText(day)}), 0) AS count`;
}

export function outcomeMatches(expected: Expected, row: SqlRow, projectId: string, discarded: boolean): boolean {
  if (row.receipt !== 1) return false;
  if (expected.kind === "残さない") return discarded && !row.item_id && row.inquiries === 0;
  if (expected.kind === "問い合わせ") return row.inquiries === 1 && !row.item_id && !row.answer_id;
  if (row.inquiries !== 0 || row.disposition !== "matched" || row.matched_project_id !== projectId || row.job_project_id !== projectId || !row.original_id) return false;
  if (expected.kind === "資料に入る") return !row.answer_id;
  return Boolean(row.answer_id) && row.answer_project_id === projectId && row.household === expected.household && row.district === expected.district && row.people_count === expected.people;
}

interface Result { scene: string; category: string; eventId: string; text: string; expected: Expected; http: number | null; observed: SqlRow; matches: boolean; note: string }
function markdownCell(value: string): string { return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " "); }

export async function runSimulation(options: SimOptions, scenes: Scenes, ports: SimPorts): Promise<{ matched: number; total: number }> {
  const base = validateTarget(options);
  parseScenes(scenes);
  const runId = crypto.randomUUID();
  const results: Result[] = [];
  let interruption = "";
  const report = () => {
    const matched = results.filter((r) => r.matches).length;
    const total = scenes.scenes.reduce((sum, scene) => sum + scene.messages.length, 0);
    const lines = ["# 公式LINEの確認（架空）", "", scenes.notice, "", `実行: ${runId}`, `対象: ${base.origin}/${options.ward}/`,
      `合った文: ${matched}/${total}。送信を試した文: ${results.length}。送っていない文: ${total - results.length}。`,
      "HTTPの成功とD1の保存結果を分けて確認します。資料の読み取りとAIによる内容の反映完了、実LINEへの到達は、この集計の対象外です。",
      "残さない結果は受信の記録、原本・届いたもの・問い合わせとして本文が残っていないこと、日ごとの件数の増加を合わせて確認します。写真を当てるための一時的な文の保持はこの判定に含みません。写真のあとの文と写真自体の判断は未確認です。",
      "返事を送れたかは問い合わせのrepliedで記録します。0なら送信完了は未確認です。原因が架空の鍵であることはWorkersのログでも確認してください。", "",
      interruption ? `停止: ${interruption}` : "送信と照合が終わりました。", "", "|場面|期待|結果|HTTP|送った文|確認した内容|", "|---|---|---|---|---|---|"];
    for (const r of results) lines.push(`|${r.scene}|${markdownCell(JSON.stringify(r.expected))}|${r.matches ? "一致" : "不一致・未確認"}|${r.http ?? "応答不明"}|${markdownCell(r.text)}|${markdownCell(r.note + " " + JSON.stringify(r.observed))}|`);
    lines.push("", "## 種類ごとの結果", "");
    for (const category of new Set(scenes.scenes.map((s) => s.category))) {
      const group = results.filter((r) => r.category === category);
      const planned = scenes.scenes.filter((s) => s.category === category).reduce((sum, s) => sum + s.messages.length, 0);
      lines.push(`- ${category}: ${group.filter((r) => r.matches).length}/${planned}`);
    }
    lines.push("", "## 外れた文と未確認の文", "");
    for (const r of results.filter((r) => !r.matches)) lines.push(`- ${r.scene} (${r.eventId}): ${r.text} / ${r.note}`);
    return lines.join("\n") + "\n";
  };
  try {
    const targets = await ports.query(preflightSql(options, scenes.projectTitle));
    const target = targets[0];
    if (targets.length !== 1 || !target || target.slug !== options.ward || typeof target.name !== "string" || !target.name.includes("架空") || target.channel_secret_binding !== "LINE_SIM_CHANNEL_SECRET" || target.access_token_binding !== "LINE_SIM_CHANNEL_ACCESS_TOKEN" || typeof target.project_id !== "string" || target.prior_answers !== 0) fail("区とチャネルの対応、架空専用の鍵の名前、開いている確認用の行事、答えが空であることをD1で確認してください。");
    const projectId = target.project_id;
    const roster = await ports.query(`SELECT e.household, e.district FROM ward_roster_entries e JOIN ward_roster_settings s ON s.ward_id = e.ward_id AND s.active_set_id = e.roster_set_id WHERE e.ward_id = ${sqlText(options.wardId)} AND s.ward_id = ${sqlText(options.wardId)}`);
    const rosterKey = (r: SqlRow) => JSON.stringify([r.household, r.district]);
    if (JSON.stringify(roster.map(rosterKey).sort()) !== JSON.stringify(scenes.roster.map(rosterKey).sort())) fail("確認用の区には場面の一覧と同じ架空の名簿を入れてください。");
    for (const scene of scenes.scenes) {
      const day = new Date().toISOString().slice(0, 10);
      const before = (await ports.query(unrelatedSql(options.wardId, day)))[0]?.count;
      if (typeof before !== "number") fail("雑談の件数を読めませんでした。");
      const pending: Result[] = [];
      for (let index = 0; index < scene.messages.length; index++) {
        const message = scene.messages[index]!;
        const eventId = `line-sim-${runId}-${scene.id}-${index}`;
        const result: Result = { scene: scene.id, category: scene.category, eventId, text: message.text, expected: message.expected, http: null, observed: { receipt: 0 }, matches: false, note: "まだ結果を確認していません。" };
        results.push(result);
        pending.push(result);
        // 通信が途切れても、送信を試した識別子を先に残す。自動再送はしない。
        await ports.record(report());
        const signed = await signedWebhook(options.destination, options.secret, eventId, `${runId}-${scene.talk}`, scene.group, message.text, Date.now() + index);
        let response: Response;
        // Workersでも作れるmanualで転送を止め、3xxは下の成功判定で失敗にする。
        try { response = await ports.fetch(new URL("/hooks/line", base), { method: "POST", headers: { "content-type": "application/json", "x-line-signature": signed.signature }, body: signed.body, redirect: "manual", signal: AbortSignal.timeout(30000) }); }
        catch { result.note = "送信の結果が不明です。同じ文を自動で送り直しません。"; fail(result.note); }
        result.http = response.status;
        await response.body?.cancel();
        if (!response.ok) { result.note = "受け口が成功を返しませんでした。"; fail(result.note); }
        // 同じ場面の文は、AIの判断を待たず続けて送る。
        await ports.sleep(200);
      }
      const deadline = Date.now() + options.waitMs;
      const expectedDiscards = scene.messages.filter((m) => m.expected.kind === "残さない").length;
      let complete = false;
      do {
        const count = (await ports.query(unrelatedSql(options.wardId, day)))[0]?.count;
        for (const result of pending) {
          const rows = await ports.query(observationSql(options.wardId, result.eventId));
          const row = rows[0];
          if (!row || rows.length !== 1) { result.note = "保存結果が一つに定まりません。"; continue; }
          result.observed = row;
          const discarded = typeof count === "number" && count - before === expectedDiscards;
          result.matches = outcomeMatches(result.expected, row, projectId, discarded);
          result.note = result.matches ? "期待と一致しました。" : "待つ時間の終わりまでに期待を確認できませんでした。";
        }
        complete = pending.every((r) => r.matches);
        if (!complete) await ports.sleep(1000);
      } while (!complete && Date.now() < deadline);
      await ports.record(report());
    }
    // 後の答えで同名の世帯の結果が変わっていないか、最後にもう一度読む。
    for (const result of results) {
      const rows = await ports.query(observationSql(options.wardId, result.eventId));
      const row = rows[0];
      if (!row || rows.length !== 1) { result.matches = false; result.note = "最後の保存結果が一つに定まりません。"; continue; }
      const discarded = result.expected.kind === "残さない" && result.matches;
      result.observed = row;
      result.matches = outcomeMatches(result.expected, row, projectId, discarded);
      result.note = result.matches ? "最後の保存結果も期待と一致しました。" : "最後の保存結果が期待と異なるか、まだ確認できません。";
    }
  } catch (error) {
    interruption = error instanceof SimError ? error.message : "実行を続けられませんでした。D1の接続と実行環境を確認してください。";
    await ports.record(report());
    throw new SimError(interruption);
  }
  await ports.record(report());
  return { matched: results.filter((r) => r.matches).length, total: results.length };
}

async function main(): Promise<void> {
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");
  const { resolve, dirname } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log("npm run line-sim -- --base http://localhost:8787 --ward <架空の区> --ward-id <区のID> [--remote] [--wait-ms 60000]\nLINE_SIM_DESTINATION / LINE_SIM_CHANNEL_SECRET / LINE_SIM_CHANNEL_ACCESS_TOKENは環境変数。D1はwrangler.tomlのDBを読みます。結果はdocs/EVIDENCE/へ残します。"); return; }
  const flags = new Map<string, string>();
  let remote = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "--remote" && !remote) { remote = true; continue; }
    if (!["--base", "--ward", "--ward-id", "--wait-ms"].includes(name) || flags.has(name) || !args[i + 1] || args[i + 1]!.startsWith("--")) fail("引数を確認してください。使い方は--helpで読めます。");
    flags.set(name, args[++i]!);
  }
  const options: SimOptions = { base: flags.get("--base") ?? "", ward: flags.get("--ward") ?? "", wardId: flags.get("--ward-id") ?? "", remote,
    waitMs: Number(flags.get("--wait-ms") ?? 60000), destination: process.env.LINE_SIM_DESTINATION ?? "", secret: process.env.LINE_SIM_CHANNEL_SECRET ?? "", accessToken: process.env.LINE_SIM_CHANNEL_ACCESS_TOKEN ?? "" };
  validateTarget(options);
  const scenes = parseScenes(JSON.parse(await readFile(resolve("fixtures/line-sim/scenes.json"), "utf8")));
  const path = resolve("docs/EVIDENCE", `line-sim-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}.md`);
  const query: Query = async (sql) => {
    // shellを挟まず、プロジェクトに入っているWranglerだけを使う。標準エラーと本文は表示しない。
    const output = await new Promise<string>((accept, reject) => execFile(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB", remote ? "--remote" : "--local", "--json", "--command", sql], { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }, (error, stdout) => error ? reject(new SimError("D1の結果を読めませんでした。接続とWranglerの実行環境を確認してください。")) : accept(stdout)));
    const data: unknown = JSON.parse(output);
    if (!Array.isArray(data) || data.length !== 1) fail("D1の結果の形を確認できませんでした。");
    const item: unknown = data[0];
    if (!item || typeof item !== "object" || !("success" in item) || item.success !== true || !("results" in item) || !Array.isArray(item.results) || item.results.some((r: unknown) => !r || typeof r !== "object" || Array.isArray(r))) fail("D1の結果を確認できませんでした。");
    return item.results as SqlRow[];
  };
  try {
    const result = await runSimulation(options, scenes, { query, fetch, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), record: async (report) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, report, "utf8"); } });
    console.log(`期待と合った文: ${result.matched}/${result.total}。結果: ${path}`);
    process.exitCode = result.matched === result.total ? 0 : 1;
  } catch (error) { console.error(error instanceof SimError ? error.message : "開始できませんでした。"); console.error(`確認記録の出力先: ${path}`); process.exitCode = 2; }
}

if (typeof process !== "undefined" && process.argv?.[1] && /(?:^|[\\/])line-sim\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => { console.error(error instanceof SimError ? error.message : "開始できませんでした。引数と場面の一覧を確認してください。"); process.exitCode = 2; });
}
