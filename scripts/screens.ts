/// <reference lib="dom" />
// 役員画面と公開画面を、状態を変更せずに撮影する。
// 紙だけ: --papers-only --event-project <行事ID> --meeting-project <総会ID>
// 班長の紙は専用QRを作った時のHTMLを --leader-html <保管した紙.html> で渡せる。作成の送信はしない。
// 測定の自己試験: node scripts/screens.ts --self-test
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--self-test")) { await selfTest(); process.exit(0); }
const arg = (key: string) => {
  const index = args.indexOf(key);
  if (index >= 0) return args[index + 1]?.startsWith("--") ? undefined : args[index + 1];
  const item = args.find((value) => value.startsWith(`${key}=`));
  return item?.slice(key.length + 1);
};

const baseArg = arg("--base");
const ward = arg("--ward");
const credsPath = arg("--creds");
const outArg = arg("--out");
if (!baseArg || !ward || !credsPath || !outArg) {
  console.error("使い方: npm run screens -- --base <URL> --ward <区> --creds <資格情報のファイル> --out <フォルダ> [--event-project <行事ID> --meeting-project <総会ID> --papers-only --leader-html <保管した紙.html>]");
  process.exit(2);
}

let base: URL;
try {
  base = new URL(baseArg);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error();
} catch {
  console.error("--baseはhttpまたはhttpsのURLを指定してください。");
  process.exit(2);
}
const baseUrl = base.toString().replace(/\/$/, "");
const wardPath = `/${encodeURIComponent(ward)}`;
const admin = `${wardPath}/admin`;
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

function readCredentials(path: string) {
  const contents = readFileSync(resolve(path), "utf8");
  const name = /^(?:名前|氏名)\s*[:：]\s*(.+)$/m.exec(contents)?.[1]?.trim();
  const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(contents)?.[1]?.trim();
  if (!name || !password) throw new Error("資格情報は「名前:」「パスワード:」形式で指定してください。");
  return { name, password };
}

type Shot = { stage: number; name: string; path: string; heading?: string; a4?: boolean; paper?: boolean };
const rows: Array<{ stage: number; name: string; width: string; file: string; result: string; note: string }> = [];
const widths = [390, 1280];
let loginReady = false;
let projectId = "";
let publishedProjectId = "";
let printPath = "";
const eventProjectId = arg("--event-project") ?? arg("--project");
const meetingProjectId = arg("--meeting-project");
const papersOnly = args.includes("--papers-only");

let browserReady = false;
let browser!: Awaited<ReturnType<typeof chromium.launch>>;
let page!: import("playwright").Page;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  let loginPosted = false;
  await context.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!loginPosted && request.method() === "POST" && url.origin === base.origin && url.pathname === `${admin}/login`) {
      loginPosted = true;
      return route.continue();
    }
    return ["GET", "HEAD"].includes(request.method()) && url.origin === base.origin
      && !/\/(?:logout|delete|revoke|join|person)(?:\/|$)/.test(url.pathname) ? route.continue() : route.abort();
  });
  page = await context.newPage();
  browserReady = true;
} catch {
  // 撮影処理は止めず、下で各画面を未撮影として一覧に残す。
}

async function openPath(path: string): Promise<void> {
  const response = await page.goto(new URL(path, `${baseUrl}/`).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!response || !response.ok()) throw new Error(`HTTP ${response?.status() ?? "応答なし"}`);
  if (page.url().includes("/admin/login")) throw new Error("IDとパスワードを入れてください");
  await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
}

function safeReason(error: unknown): string {
  if (error instanceof Error) {
    const http = /HTTP \d+/.exec(error.message)?.[0];
    if (http) return http;
    if (error.message.includes("入る")) return "IDとパスワードを入れてください";
    if (error.message.includes("ブラウザー")) return "ブラウザーを起動できませんでした";
    if (error.name === "TimeoutError") return "表示を待つ時間が上限に達しました";
  }
  return "画面を開けませんでした";
}

async function discover() {
  // 開いているプロジェクト一覧は年・作成日の新しい順。
  await openPath(`${admin}/projects`);
  const projectLinks = await page.locator(`a[href*="/admin/projects/"]`).evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? "")
      .filter((href) => new RegExp(`/admin/projects/[0-9a-f-]{36}$`).test(href)),
  );
  projectId = eventProjectId ?? projectLinks[0]?.split("/").at(-1) ?? "";
  if (projectId) return;

  // 区内のプロジェクトがすべて閉じている場合は、記録の先頭を最新候補にする。
  await openPath(`${admin}/archive`);
  const archived = await page.locator(`a[href*="${admin}/archive/"]`).evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? "")
      .filter((href) => new RegExp(`${admin}/archive/[^/]+$`).test(href)),
  );
  projectId = archived[0]?.split("/").at(-1) ?? "";
}

async function discoverPublished() {
  try {
    await openPath(`${wardPath}/`);
    const href = await page.locator(`a[href*="/${encodeURIComponent(ward ?? "")}/p/"]`).first().getAttribute("href");
    if (href) publishedProjectId = href.split("/").at(-1) ?? "";
  } catch {
    // 各公開画面の行で失敗を一覧化する。
  }
  if (!publishedProjectId && projectId) publishedProjectId = projectId;
}

async function discoverPrint() {
  if (!projectId) return;
  try {
    await openPath(`${admin}/publish/${encodeURIComponent(projectId)}`);
    const href = await page.locator("a").filter({ hasText: "印刷用ページを開く" }).first().getAttribute("href");
    if (href) printPath = href;
  } catch {
    // 印刷用ページの撮影行に理由を残す。
  }
}

const shots: Shot[] = [
  { stage: 0, name: "最初の画面", path: `${admin}/`, heading: "の自治会の仕事を進める画面です" },
  { stage: 0, name: "名簿", path: `${admin}/answers/roster`, heading: "名簿" },
  { stage: 0, name: "今やること", path: `${admin}/projects/today`, heading: "今やること" },
  { stage: 0, name: "問い合わせと要望", path: `${admin}/inquiries`, heading: "問い合わせと要望" },
  { stage: 0, name: "帳簿", path: `${admin}/ledger`, heading: "帳簿" },
  { stage: 0, name: "役員の一覧", path: `${admin}/settings/people`, heading: "役員の一覧" },
  { stage: 0, name: "区の設定", path: `${admin}/settings`, heading: "区の設定" },
  { stage: 1, name: "段取り", path: "project/map", heading: "段取り" },
  { stage: 1, name: "資料", path: "project", heading: "資料とその影響" },
  { stage: 1, name: "質問", path: "project/questions", heading: "分かるものだけ答えてください" },
  { stage: 1, name: "送る", path: `${admin}/intake`, heading: "手元の紙や資料を送る" },
  { stage: 1, name: "行事に資料を送る", path: "project/intake", heading: "に資料を送る" },
  { stage: 1, name: "行事の収支", path: "project/ledger", heading: "の収支" },
  { stage: 1, name: "送ったもの", path: `${admin}/intake/received`, heading: "受け取りました" },
  { stage: 1, name: "読み終わったもの", path: `${admin}/intake/read`, heading: "読み終わりました" },
  { stage: 1, name: "届いたもの", path: `${admin}/inbox`, heading: "届いたもの" },
  { stage: 2, name: "下書き", path: "project/draft", heading: "案内の下書きを直す" },
  { stage: 2, name: "配る", path: "project/publish", heading: "配る" },
  { stage: 2, name: "出す", path: "print", heading: "印刷用ページ", a4: true },
  { stage: 2, name: "公式LINEの案内", path: `${wardPath}/line`, heading: "新しいお知らせを、LINEで受け取る" },
  { stage: 2, name: "個人情報の扱い", path: `${wardPath}/privacy`, heading: "個人情報の扱い" },
  { stage: 2, name: "区のページ", path: "public/ward", heading: "お知らせ" },
  { stage: 2, name: "行事のページ", path: "public/project", heading: "" },
  { stage: 3, name: "答えを見る", path: "project/answers", heading: "答え" },
  { stage: 3, name: "答えの入口", path: "public/answer", heading: "出欠を教えてください" },
  { stage: 4, name: "実行委員と班長のページ", path: "project/space", heading: "実行委員と班長のページ" },
  { stage: 5, name: "再配布", path: "project/publish", heading: "配る" },
  { stage: 6, name: "閉じる", path: "project/close", heading: "閉じ" },
  { stage: 6, name: "一年の予定", path: `${admin}/archive/map`, heading: "一年の予定" },
  { stage: 6, name: "記録", path: `${admin}/archive`, heading: "記録" },
];

const paperShots: Shot[] = [
  { stage: 2, name: "行事の案内と回答票", path: "paper/event/announcement", a4: true, paper: true },
  { stage: 2, name: "行事の回答票だけ", path: "paper/event/answer", a4: true, paper: true },
  { stage: 2, name: "行事の掲示", path: "paper/event/poster", a4: true, paper: true },
  { stage: 2, name: "班長への一枚", path: "paper/event/leader", a4: true, paper: true },
  { stage: 4, name: "配った当番表", path: "paper/event/duty", a4: true, paper: true },
  { stage: 2, name: "総会の招集と回答票", path: "paper/meeting/announcement", a4: true, paper: true },
];
const selectedShots = papersOnly ? paperShots : [...shots, ...paperShots];
const paperLinks = new Map<string, { href: string; announcement: boolean }[]>();

async function publishedPaper(id: string, kind: string) {
  if (!id) return "";
  if (!paperLinks.has(id)) {
    await openPath(`${admin}/print/${encodeURIComponent(id)}`);
    paperLinks.set(id, await page.locator("a[href]").evaluateAll((links) => links.map((link) => ({
      href: link.getAttribute("href") ?? "", announcement: link.querySelector("b")?.textContent === "案内と回答票",
    }))));
  }
  const prefix = `${admin}/print/${encodeURIComponent(id)}/`;
  return paperLinks.get(id)?.find(({ href, announcement }) => {
    if (!href.startsWith(prefix)) return false;
    if (kind === "announcement" && !announcement) return false;
    const parts = href.slice(prefix.length).split("/");
    return parts.length === 3 && /^\d+$/.test(parts[1] ?? "") && parts[2] === kind;
  })?.href ?? "";
}

async function measurePaper(target: Page) {
  const sizes = await target.locator("section.sheet").evaluateAll((sheets) => sheets.map((sheet) => ({
    width: Math.max(sheet.getBoundingClientRect().width, sheet.scrollWidth),
    height: Math.max(sheet.getBoundingClientRect().height, sheet.scrollHeight),
  })));
  if (!sizes.length) return null;
  // Chromiumが印刷するPDFをメモリ上で数える。PDF自体や中身は保存・記録しない。
  const pdf = await target.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const pages = [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
  if (!pages) throw new Error("紙の枚数を数えられませんでした");
  const fits = pages === sizes.length && sizes.every((size) => size.width <= 795 && size.height <= 1124);
  return { pages, faces: sizes.length, fits };
}

async function pathFor(shot: Shot): Promise<string> {
  if (shot.paper) {
    const [, role, kind] = shot.path.split("/");
    return publishedPaper(role === "meeting" ? meetingProjectId ?? "" : eventProjectId ?? projectId, kind ?? "");
  }
  if (shot.path === "project") return `${admin}/projects/${encodeURIComponent(projectId)}`;
  if (shot.path === "project/questions") return `${admin}/projects/${encodeURIComponent(projectId)}/questions`;
  if (shot.path === "project/intake") return `${admin}/intake?project=${encodeURIComponent(projectId)}`;
  if (shot.path === "project/ledger") return `${admin}/projects/${encodeURIComponent(projectId)}/ledger`;
  if (shot.path === "project/map") return `${admin}/projects/${encodeURIComponent(projectId)}/map`;
  if (shot.path === "project/draft") return `${admin}/projects/${encodeURIComponent(projectId)}/draft/announcement`;
  if (shot.path === "project/publish") return `${admin}/publish/${encodeURIComponent(projectId)}`;
  if (shot.path === "project/space") return `${admin}/space/${encodeURIComponent(projectId)}`;
  if (shot.path === "project/answers") return `${admin}/answers/${encodeURIComponent(projectId)}`;
  if (shot.path === "project/close") return `${admin}/close/${encodeURIComponent(projectId)}`;
  if (shot.path === "public/ward") return `${wardPath}/`;
  if (shot.path === "public/project") return `${wardPath}/p/${encodeURIComponent(publishedProjectId)}`;
  if (shot.path === "public/answer") return `${wardPath}/answer/${encodeURIComponent(publishedProjectId)}`;
  if (shot.path === "print") return printPath;
  return shot.path;
}

async function capture(shot: Shot, width: number) {
  const suffix = shot.a4 && width === 1280 ? "794" : String(width);
  const file = `${shot.name}-${suffix}.png`;
  try {
    const savedLeader = shot.path === "paper/event/leader" ? arg("--leader-html") : undefined;
    const path = savedLeader ? "" : await pathFor(shot);
    if (!path && !savedLeader) {
      rows.push({ stage: shot.stage, name: shot.name, width: suffix, file: "", result: "未撮影", note: "配った対象の紙を見つけられませんでした。行事・総会の指定も確かめてください。" });
      return;
    }
    await page.setViewportSize({ width: shot.a4 && width === 1280 ? 794 : width, height: shot.a4 && width === 1280 ? 1123 : width === 390 ? 844 : 800 });
    if (savedLeader) await page.setContent(readFileSync(resolve(savedLeader), "utf8"), { waitUntil: "domcontentloaded" });
    else await openPath(path);
    let note = savedLeader ? "保管した班長の紙のHTMLから撮影。" : shot.paper ? `参照: ${path}。` : "";
    if (shot.paper) {
      await page.emulateMedia({ media: "print" });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const measured = await measurePaper(page);
      if (!measured) {
        rows.push({ stage: shot.stage, name: shot.name, width: suffix, file: "", result: "未撮影", note: shot.path.endsWith("/leader") ? "専用QRを作る操作が必要です。この道具では作成しません。" : "印刷する紙がありません。枚数は未確認です。" });
        return;
      }
      note += `A4のPDF${measured.pages}枚、紙${measured.faces}面。${measured.fits ? "各面は一枚以内です。" : "一枚を超える面か横のはみ出しがあります。"}`;
    }
    if (shot.heading) {
      const heading = page.getByRole("heading", { name: shot.heading, exact: false }).first();
      if (await heading.count()) await heading.scrollIntoViewIfNeeded({ timeout: 5000 });
    }
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(out, file), fullPage: true, animations: "disabled" });
    rows.push({ stage: shot.stage, name: shot.name, width: suffix, file, result: "撮影", note });
  } catch (error) {
    rows.push({ stage: shot.stage, name: shot.name, width: suffix, file, result: "未撮影", note: safeReason(error) });
  } finally { await page.emulateMedia({ media: "screen" }); }
}

try {
  if (!browserReady) throw new Error("ブラウザーを起動できませんでした");
  const credentials = readCredentials(credsPath);
  await page.goto(new URL(`${admin}/login`, `${baseUrl}/`).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[name="loginId"]').fill(credentials.name);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.getByRole("button", { name: "入る" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/admin/login"), { timeout: 15000 }).catch(async () => {
    // 通し用の区は名前と合言葉で入る。今の入口で入れない時だけ、互換の入口を使う。
    const response = await page.request.post(new URL(`${admin}/login`, `${baseUrl}/`).toString(), {
      form: { name: credentials.name, password: credentials.password }, headers: { origin: base.origin }, maxRedirects: 0,
    });
    if (response.status() !== 303) throw new Error("IDとパスワードを入れてください");
  });
  await openPath(`${admin}/`);
  loginReady = true;
} catch (error) {
  rows.push({ stage: 0, name: "役員入る", width: "共通", file: "", result: "失敗", note: safeReason(error) });
} finally {
  // 以降の処理では資格情報を保持しない。
}

if (loginReady) {
  if (papersOnly) projectId = eventProjectId ?? "";
  else {
    try { await discover(); } catch { /* 対象がない旨を各画面へ記録する */ }
    await discoverPublished();
    await discoverPrint();
  }
  for (const shot of selectedShots) {
    for (const width of shot.a4 ? [1280] : widths) await capture(shot, width);
  }
} else {
  for (const shot of selectedShots) {
    for (const width of shot.a4 ? [1280] : widths) {
      const suffix = shot.a4 && width === 1280 ? "794" : String(width);
      rows.push({ stage: shot.stage, name: shot.name, width: suffix, file: `${shot.name}-${suffix}.png`, result: "未撮影", note: "役員入るできませんでした" });
    }
  }
}

if (browserReady) await browser.close();
const ordered = rows.sort((a, b) => a.stage - b.stage || selectedShots.findIndex((shot) => shot.name === a.name) - selectedShots.findIndex((shot) => shot.name === b.name) || a.width.localeCompare(b.width));
const lines = [
  "# 画面撮影一覧",
  "",
  `- 区: ${ward}`,
  `- 対象行事: ${projectId || "見つかりませんでした"}`,
  `- 対象総会: ${meetingProjectId || "指定なし"}`,
  "- 資格情報: 値は表示・記録していません",
  "- 通常の画面は390pxと1280px。紙は印刷の見た目でA4幅794px・全長を撮影します。",
  "- 紙の枚数はブラウザのA4印刷で確認します。班ごとの複数面と、一面のはみ出しを分けて記録します。実物の印刷・QRの読み取りは未確認です。",
  "- 班長の専用QRは作成しません。作成時に保管した紙のHTMLを--leader-htmlで渡せます。渡さない場合、準備画面だけなら未撮影になります。",
  "",
  "| 段 | 画面 | 幅 | ファイル | 結果 | メモ |",
  "|---:|---|---:|---|---|---|",
  ...ordered.map((row) => `| ${row.stage} | ${row.name} | ${row.width} | ${row.file ? `\`${row.file}\`` : "—"} | ${row.result} | ${row.note || "—"} |`),
  "",
];
writeFileSync(resolve(out, "index.md"), lines.join("\n"), "utf8");
console.log(`撮影一覧を書きました: ${resolve(out, "index.md")}`);

async function selfTest() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    await page.emulateMedia({ media: "print" });
    const html = (count: number, height: number) => `<style>@page{size:A4;margin:0}body{margin:0}.sheet{box-sizing:border-box;width:210mm;min-height:296mm;break-after:page}.sheet:last-child{break-after:auto}</style>${Array.from({ length: count }, () => `<section class="sheet"><div style="height:${height}px">架空の紙</div></section>`).join("")}`;
    for (const count of [1, 2]) {
      await page.setContent(html(count, 100));
      assert.deepEqual(await measurePaper(page), { pages: count, faces: count, fits: true });
    }
    await page.setContent(html(1, 1500));
    const long = await measurePaper(page);
    assert.ok(long && long.pages > 1 && !long.fits);
    await page.setContent("<h1>架空の準備画面</h1>");
    assert.equal(await measurePaper(page), null);
    console.log("架空の紙で一枚・二面・はみ出し・準備画面の測定を確認しました。");
  } finally { await browser.close(); }
}
