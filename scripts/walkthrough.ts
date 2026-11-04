// staging の役員画面を HTTP でたどる。資格情報は表示・記録しない。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const onlyPublic = args.includes("--only-public");
const ward = arg("--ward");
const baseArg = arg("--base");
if (!ward || !baseArg || (!onlyPublic && !arg("--creds"))) {
  console.error("使い方: npm run walkthrough -- --base <URL> --ward <区のURL名> --creds <資格情報ファイル> [--only-public]");
  process.exit(2);
}
const base = new URL(baseArg).toString().replace(/\/$/, "");
const origin = new URL(base).origin;
const wardPath = "/" + encodeURIComponent(ward);
const admin = wardPath + "/admin";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = resolve(root, "docs/EVIDENCE/walkthrough-" + stamp + ".md");
mkdirSync(dirname(evidence), { recursive: true });
const rows: string[] = [];
const cookies = new Map<string, string>();
let currentStage = "準備";
let currentStarted = Date.now();
function record(stage: string, result: string, what: string, start: number) {
  rows.push("| " + stage + " | " + result + " | " + what.replaceAll("|", "／") + " | " + Math.round((Date.now() - start) / 1000) + " |");
  writeFileSync(evidence, [
    "# staging 通し確認 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }), "",
    "- 区: " + ward, "- 一斉送信: 実送信なし（送らない選択）", "- 資格情報: 値は記録していません", "",
    "| 段 | 結果 | 見えた物 | 秒 |", "|---|---|---|---:|", ...rows, ""
  ].join("\n"), "utf8");
  console.log(stage + ": " + result + " (" + Math.round((Date.now() - start) / 1000) + " 秒)");
  currentStage = "完了";
}
function skipStage(stage: string, reason: string) {
  record(stage, "飛ばす", reason, Date.now());
  process.exitCode = 1;
}
function unescapeHtml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  if (cookies.size) headers.set("cookie", [...cookies.values()].join("; "));
  const res = await fetch(new URL(path, base + "/"), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    if (pair) {
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair);
    }
  }
  return res;
}
async function post(path: string, values: Record<string, string>) {
  return req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
}
async function get(path: string) {
  const response = await req(path);
  return { response, html: await response.text() };
}
function readForm(html: string, path: string, sectionTitle?: string) {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = unescapeHtml(/\baction="([^"]*)"/i.exec(form[1] ?? "")?.[1] ?? "");
    if (!action.includes(path)) continue;
    const sectionStart = html.lastIndexOf("<section", form.index ?? 0);
    if (sectionTitle && !html.slice(sectionStart, form.index).includes(sectionTitle)) continue;
    const fields: Record<string, string> = {};
    const body = form[2] ?? "";
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const a = input[1] ?? "";
      const name = /\bname="([^"]*)"/i.exec(a)?.[1];
      const type = /\btype="([^"]*)"/i.exec(a)?.[1];
      if (name && type !== "file" && type !== "submit") fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(a)?.[1] ?? "");
    }
    for (const t of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(t[1] ?? "")?.[1];
      if (name) fields[name] = unescapeHtml(t[2] ?? "");
    }
    for (const s of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(s[1] ?? "")?.[1];
      const options = [...(s[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(o => /\bselected(?:\s|=|>)/i.test(o[1] ?? "")) ?? options[0];
      if (name && selected) fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(selected[1] ?? "")?.[1] ?? (selected[2] ?? ""));
    }
    return { action, fields };
  }
  throw new Error("画面の入力欄がありません: " + path);
}
async function waitFor(name: string, project: string): Promise<boolean> {
  const until = Date.now() + 600_000;
  while (Date.now() < until) {
    const { html } = await get(admin + "/intake?project=" + encodeURIComponent(project));
    const pos = html.indexOf(name);
    const state = pos < 0 ? html : html.slice(pos, pos + 900);
    if (state.includes("反映しました")) return true;
    if (state.includes("読めませんでした") || state.includes("読み取りが遅れています")) throw new Error(name + " の読み取り・反映が止まりました");
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}
async function publish(project: string, html: string, scope: "public" | "space", sectionTitle?: string) {
  const suffix = scope === "public" ? "/confirm" : "/space";
  const first = readForm(html, "/publish/" + project + suffix, sectionTitle);
  if (scope === "public") first.fields.lineDelivery = "skip";
  const confirm = await post(first.action, first.fields);
  if (!confirm.ok) throw new Error("配布内容の確認で停止 (" + confirm.status + ")");
  const page = await confirm.text();
  if (scope === "space") return confirm;
  if (!page.includes("今回は公式 LINE に送りません")) throw new Error("LINE を送らない選択を確認できません");
  const final = readForm(page, "/publish/" + project + "/send");
  if (final.fields.lineDelivery !== "skip") throw new Error("LINE 送信を止められません");
  return post(final.action, final.fields);
}
async function runPublic() {
  const start = Date.now();
  currentStage = "公開確認";
  currentStarted = start;
  const home = await get(wardPath + "/");
  if (!home.response.ok) throw new Error("区の公開ページを開けません");
  const found = [...home.html.matchAll(/href="(\/[^"]+\/p\/[^"#?]+)"/g)];
  if (!found.length) throw new Error("公開された案内がありません");
  const link = unescapeHtml(found.at(-1)?.[1] ?? "");
  const publicPage = await get(link);
  const project = link.split("/").at(-1) ?? "";
  const answer = await get(wardPath + "/answer/" + project);
  if (!publicPage.response.ok || !answer.response.ok) throw new Error("公開のお知らせまたは回答入口を開けません");
  record("公開確認", "通過", "公開のお知らせと登録なしの回答入口。役員ログインなし。", start);
}
async function runFull() {
  let intakeOk = false;
  let publicOk = false;
  let project = "";
  let draftPath = "";
  let publicPath = "";
  let start = Date.now();
  currentStage = "0";
  currentStarted = start;
  try {
    const cred = readFileSync(resolve(arg("--creds")!), "utf8");
    const name = /^(?:名前|氏名)\s*[:：]\s*(.+)$/m.exec(cred)?.[1]?.trim();
    const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(cred)?.[1]?.trim();
    if (!name || !password) throw new Error("資格情報は「名前:」「パスワード:」形式で指定してください");
    const login = await post(admin + "/login", { name, password });
    if (login.status !== 303 || !cookies.has("device") || !(await get(admin + "/")).response.ok) throw new Error("役員画面に入れません");
    record("0", "通過", "資格情報でログイン。値は表示していない。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("0", "停止", message, start);
    process.exitCode = 1;
    for (const n of ["1", "2", "3", "4", "5", "6"]) skipStage(n, "役員画面に入れず、後続操作を実行できません");
    return;
  }

  start = Date.now();
  currentStage = "1";
  currentStarted = start;
  try {
  const opened = await post(admin + "/projects", { kind: "event", year: String(new Date().getFullYear()) });
  project = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1] ?? "";
  if (opened.status !== 303 || !project) throw new Error("新しいプロジェクトを開けません");
  const title = "架空 秋の収穫祭 " + stamp.slice(0, 13);
  await post(admin + "/projects/" + project + "/title", { title });
  record("1", "通過", "新規プロジェクト「" + title + "」を作成。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("1", "停止", message, start);
    process.exitCode = 1;
    for (const n of ["2", "3", "4", "5", "6"]) skipStage(n, "プロジェクトを作成できず、後続操作を実行できません");
    return;
  }

  start = Date.now();
  currentStage = "2";
  currentStarted = start;
  try {
  const unfinished: string[] = [];
  const files = [
    "fixtures/last-year/accountant/IMG_2081.jpg",
    "fixtures/last-year/vice-chair/配置のメモ.jpg",
    "fixtures/this-year/meeting/役員会のメモ.jpg",
    "fixtures/this-year/meeting/電話の結果_公民館.txt"
  ];
  for (const relative of files) {
    const path = resolve(root, relative);
    const filename = basename(path);
    const type = filename.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "text/plain";
    const data = new FormData();
    data.set("project_id", project);
    data.append("part", new Blob([readFileSync(path)], { type }), filename);
    data.append("part_kind", type === "image/jpeg" ? "photo" : "file");
    const sent = await req(admin + "/intake", { method: "POST", headers: { accept: "application/json" }, body: data });
    const result = await sent.json().catch(() => null) as { ok?: boolean; jobId?: string | null; duplicates?: number } | null;
    if (!sent.ok || !result?.ok) throw new Error("架空資料を送れません: " + filename);
    if (result.jobId) {
      try {
        if (!(await waitFor(filename, project))) unfinished.push(filename + "（読み取り・反映待ちの上限）");
      } catch (error) {
        unfinished.push(filename + "（" + (error instanceof Error ? error.message : "読み取り未完了") + "）");
      }
    } else if (!result.duplicates) {
      throw new Error("送信結果に入った物も同じ物の記録もありません: " + filename);
    }
  }
  if ((await post(admin + "/projects/" + project + "/draft/announcement/start", {})).status !== 303) throw new Error("AI に案内を頼めません");
  draftPath = admin + "/projects/" + project + "/draft/announcement";
  let draftPage = await get(draftPath);
  let draft = readForm(draftPage.html, "/draft/announcement/save");
  const end = Date.now() + 600_000;
  while (!draft.fields.text?.trim() && Date.now() < end) {
    await new Promise(r => setTimeout(r, 3000));
    draftPage = await get(draftPath);
    draft = readForm(draftPage.html, "/draft/announcement/save");
  }
  if (!draft.fields.text?.trim()) unfinished.push("案内の下書き（待ちの上限）");
  intakeOk = unfinished.length === 0;
  if (!intakeOk) process.exitCode = 1;
  record("2", intakeOk ? "通過" : "未完了", "架空の実ファイル4件を送信。同じ物はそのまま利用。" + (unfinished.length ? " 未完了: " + unfinished.join("、") : " AIの読み取り・反映と案内作成を確認。"), start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("2", "停止", message, start);
    process.exitCode = 1;
  }

  if (intakeOk) try {
  start = Date.now();
  currentStage = "3";
  currentStarted = start;
  const published = await publish(project, (await get(admin + "/publish/" + project)).html, "public");
  if (published.status !== 303) throw new Error("案内を公開できません");
  publicPath = wardPath + "/p/" + project;
  if (!(await get(publicPath)).response.ok) throw new Error("公開ページを開けません");
  const printPage = await get(admin + "/publish/" + project);
  const printPath = unescapeHtml(/href="([^"]*\/print\/[^"]+)"/.exec(printPage.html)?.[1] ?? "");
  if (!printPath || !(await get(printPath)).response.ok) throw new Error("印刷用ページを開けません");
  const answer = await post(wardPath + "/answer/" + project, {
    household: "架空 小林", district: "1班", people_count: "2", helper_name: "架空 小林さと", helper_times: "受付 10:30-12:00"
  });
  if (answer.status !== 303) throw new Error("架空の回答を送れません");
  record("3", "通過", "公開ページ、印刷用ページ、架空の回答。公式 LINE は送信なし。", start);
  publicOk = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("3", "停止", message, start);
    process.exitCode = 1;
  }
  else skipStage("3", "段 2 が完了していないため、公開できる状態か確認できません");

  start = Date.now();
  currentStage = "4";
  currentStarted = start;
  try {
  const passphrase = "架空の合言葉-" + stamp.slice(0, 12);
  if ((await post(admin + "/space/" + project + "/open", { passphrase })).status !== 303) throw new Error("空間を開けません");
  if ((await post(admin + "/projects/" + project + "/draft/duty_roster/start", {})).status !== 303) throw new Error("当番表の案を頼めません");
  let dutyPage = await get(admin + "/projects/" + project + "/draft/duty_roster");
  let duty = readForm(dutyPage.html, "/draft/duty_roster/save");
  const dutyEnd = Date.now() + 600_000;
  while (!duty.fields.text?.trim() && Date.now() < dutyEnd) {
    await new Promise(r => setTimeout(r, 3000));
    dutyPage = await get(admin + "/projects/" + project + "/draft/duty_roster");
    duty = readForm(dutyPage.html, "/draft/duty_roster/save");
  }
  if (!duty.fields.text?.trim()) throw new Error("未完了: 当番表の案が待ちの上限までにできませんでした");
  if ((await post(duty.action, duty.fields)).status !== 303) throw new Error("当番表の案を保存できません");
  if ((await publish(project, (await get(admin + "/publish/" + project)).html, "space")).status !== 303) throw new Error("空間に当番表を出せません");
  if ((await post(wardPath + "/space/" + project + "/enter", { passphrase })).status !== 303) throw new Error("空間に入れません");
  const space = await get(wardPath + "/space/" + project);
  if (!space.response.ok || !space.html.includes("当番表")) throw new Error("空間の当番表を読めません");
  record("4", "通過", "空間を開き、当番表を配って合言葉で読み取り。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("4", message.startsWith("未完了:") ? "未完了" : "停止", message.replace(/^未完了:\s*/, ""), start);
    process.exitCode = 1;
  }

  if (publicOk) try {
  start = Date.now();
  currentStage = "5";
  currentStarted = start;
  const rain = readForm((await get(draftPath)).html, "/draft/announcement/save");
  rain.fields.text = "雨天のため、会場を公民館のホールと集会室に変更します。日時は予定どおりです。";
  if ((await post(rain.action, rain.fields)).status !== 303) throw new Error("雨天のお知らせを保存できません");
  const secondEdition = readForm((await get(admin + "/publish/" + project)).html, "/publish/" + project + "/confirm");
  if (secondEdition.fields.versionNo !== "2") throw new Error("雨天のお知らせが二つ目の版になっていません");
  if ((await publish(project, (await get(admin + "/publish/" + project)).html, "public")).status !== 303) throw new Error("雨天のお知らせを配れません");
  const rainy = await get(publicPath);
  if (!rainy.response.ok || !rainy.html.includes("雨天のため")) throw new Error("雨天の変更が公開されていません");
  record("5", "通過", "同じ公開ページに雨天の変更を追加。公式 LINE は送信なし。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("5", "停止", message, start);
    process.exitCode = 1;
  }
  else skipStage("5", "段 3 の公開を確認できず、変更版を作れません");

  if (publicOk) try {
  start = Date.now();
  currentStage = "6";
  currentStarted = start;
  if ((await post(admin + "/close/" + project + "/prepare", {})).status !== 303) throw new Error("閉じる前の準備に失敗");
  const closePath = admin + "/close/" + project;
  let closePage = await get(closePath);
  for (let i = 0; i < 200 && closePage.html.includes("準備中"); i++) {
    await new Promise(r => setTimeout(r, 3000));
    closePage = await get(closePath);
  }
  if (!closePage.html.includes("報告: できました") || !closePage.html.includes("地図: できました")) throw new Error("未完了: 実施報告または地図のAI下書きが待ちの上限までにできませんでした");
  const report = readForm(closePage.html, "/close/" + project + "/report/public");
  report.fields.body = "架空の秋の収穫祭を実施しました。雨天会場に変更して開催しました。";
  if ((await post(report.action, report.fields)).status !== 303) throw new Error("報告を保存できません");
  const reportPublish = await get(admin + "/publish/" + project);
  if ((await publish(project, reportPublish.html, "public", "実施報告")).status !== 303) throw new Error("実施報告を公開できません");
  if (!(await get(wardPath + "/p/" + project)).html.includes("実施しました")) throw new Error("公開ページに実施報告がありません");
  if ((await post(admin + "/close/" + project + "/finalize", {})).status !== 303) throw new Error("閉じる操作に失敗");
  const archive = await get(admin + "/archive/" + project);
  const seed = readForm(archive.html, "/archive/" + project + "/seed");
  seed.fields.title = "架空 秋の収穫祭 " + (new Date().getFullYear() + 1);
  seed.fields.year = String(new Date().getFullYear() + 1);
  seed.fields.eventDay = (new Date().getFullYear() + 1) + "-10-24";
  const next = await post(seed.action, seed.fields);
  const nextId = /\/projects\/([^/]+)\/map$/.exec(next.headers.get("location") ?? "")?.[1];
  if (next.status !== 303 || !nextId || !(await get(admin + "/projects/" + nextId + "/map")).response.ok) throw new Error("来年の種から開けません");
  record("6", "通過", "報告を保存して閉じ、記録から来年のプロジェクトを開いた。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("6", message.startsWith("未完了:") ? "未完了" : "停止", message.replace(/^未完了:\s*/, ""), start);
    process.exitCode = 1;
  }
  else skipStage("6", "案内の公開を確認できず、閉じる段を進められません");
}
try {
  if (onlyPublic) await runPublic();
  else await runFull();
  console.log("記録: " + evidence);
} catch (error) {
  const message = error instanceof Error ? error.message : "処理に失敗しました";
  rows.push("| " + currentStage + " | 停止 | " + message + " | " + Math.round((Date.now() - currentStarted) / 1000) + " |");
  writeFileSync(evidence, ["# staging 通し確認", "", "- 区: " + ward, "- 資格情報: 値は記録していません", "- 一斉送信: 実送信なし", "", "| 段 | 結果 | 見えた物 | 秒 |", "|---|---|---|---:|", ...rows, ""].join("\n"), "utf8");
  console.error("停止: " + message);
  console.error("記録: " + evidence);
  process.exitCode = 1;
}
