/// <reference lib="dom" />
// 役員画面と公開画面を、状態を変更せずに撮影する。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (key: string) => {
  const index = args.indexOf(key);
  if (index >= 0) return args[index + 1];
  const item = args.find((value) => value.startsWith(`${key}=`));
  return item?.slice(key.length + 1);
};

const baseArg = arg("--base");
const ward = arg("--ward");
const credsPath = arg("--creds");
const outArg = arg("--out");
if (!baseArg || !ward || !credsPath || !outArg) {
  console.error("使い方: npm run screens -- --base <URL> --ward <区> --creds <資格情報のファイル> --out <フォルダ>");
  process.exit(2);
}

let base: URL;
try {
  base = new URL(baseArg);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error();
} catch {
  console.error("--base は http または https の URL を指定してください。");
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

type Shot = { stage: number; name: string; path: string; heading?: string; a4?: boolean };
const rows: Array<{ stage: number; name: string; width: string; file: string; result: string; note: string }> = [];
const widths = [390, 1280];
let loginReady = false;
let projectId = "";
let publishedProjectId = "";
let printPath = "";

let browserReady = false;
let browser!: Awaited<ReturnType<typeof chromium.launch>>;
let page!: import("playwright").Page;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  browserReady = true;
} catch {
  // 撮影処理は止めず、下で各画面を未撮影として一覧に残す。
}

async function openPath(path: string): Promise<void> {
  const response = await page.goto(new URL(path, `${baseUrl}/`).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!response || !response.ok()) throw new Error(`HTTP ${response?.status() ?? "応答なし"}`);
  if (page.url().includes("/admin/login")) throw new Error("ログインが必要です");
  await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
}

function safeReason(error: unknown): string {
  if (error instanceof Error) {
    const http = /HTTP \d+/.exec(error.message)?.[0];
    if (http) return http;
    if (error.message.includes("ログイン")) return "ログインが必要です";
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
  projectId = arg("--project") ?? projectLinks[0]?.split("/").at(-1) ?? "";
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
  { stage: 0, name: "役員のトップ", path: `${admin}/`, heading: "役員画面" },
  { stage: 0, name: "名簿", path: `${admin}/answers/roster`, heading: "名簿" },
  { stage: 0, name: "区の設定", path: `${admin}/settings`, heading: "区の設定" },
  { stage: 1, name: "地図", path: "project/map", heading: "地図" },
  { stage: 1, name: "材料", path: "project", heading: "材料とその影響" },
  { stage: 1, name: "問い", path: "project", heading: "問い" },
  { stage: 1, name: "受け箱", path: `${admin}/inbox`, heading: "受け箱" },
  { stage: 2, name: "案", path: "project/draft", heading: "案" },
  { stage: 2, name: "配る", path: "project/publish", heading: "配る" },
  { stage: 2, name: "出す", path: "print", heading: "印刷用ページ", a4: true },
  { stage: 2, name: "区のページ", path: "public/ward", heading: "お知らせ" },
  { stage: 2, name: "プロジェクトのページ", path: "public/project", heading: "" },
  { stage: 3, name: "戻る", path: `${admin}/answers`, heading: "戻る" },
  { stage: 3, name: "回答の入口", path: "public/answer", heading: "回答" },
  { stage: 4, name: "空間の管理", path: "project/space", heading: "空間" },
  { stage: 5, name: "再配布", path: "project/publish", heading: "配る" },
  { stage: 6, name: "報告と閉じる", path: "project/close", heading: "報告" },
  { stage: 6, name: "記録", path: `${admin}/archive`, heading: "記録" },
];

async function pathFor(shot: Shot): Promise<string> {
  if (shot.path === "project") return `${admin}/projects/${encodeURIComponent(projectId)}`;
  if (shot.path === "project/map") return `${admin}/projects/${encodeURIComponent(projectId)}/map`;
  if (shot.path === "project/draft") return `${admin}/projects/${encodeURIComponent(projectId)}/draft`;
  if (shot.path === "project/publish") return `${admin}/publish/${encodeURIComponent(projectId)}`;
  if (shot.path === "project/space") return `${admin}/space/${encodeURIComponent(projectId)}`;
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
  const path = await pathFor(shot);
  if (!path) {
    rows.push({ stage: shot.stage, name: shot.name, width: suffix, file, result: "未撮影", note: "対象ページを見つけられませんでした" });
    return;
  }
  try {
    await page.setViewportSize({ width: shot.a4 && width === 1280 ? 794 : width, height: shot.a4 && width === 1280 ? 1123 : width === 390 ? 844 : 800 });
    await openPath(path);
    if (shot.heading) {
      const heading = page.getByRole("heading", { name: shot.heading, exact: false }).first();
      if (await heading.count()) await heading.scrollIntoViewIfNeeded({ timeout: 5000 });
    }
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(out, file), fullPage: false, animations: "disabled" });
    rows.push({ stage: shot.stage, name: shot.name, width: suffix, file, result: "撮影", note: "" });
  } catch (error) {
    rows.push({ stage: shot.stage, name: shot.name, width: suffix, file, result: "未撮影", note: safeReason(error) });
  }
}

try {
  if (!browserReady) throw new Error("ブラウザーを起動できませんでした");
  const credentials = readCredentials(credsPath);
  await page.goto(new URL(`${admin}/login`, `${baseUrl}/`).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[name="loginId"]').fill(credentials.name);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/admin/login"), { timeout: 15000 });
  await openPath(`${admin}/`);
  loginReady = true;
} catch (error) {
  rows.push({ stage: 0, name: "役員ログイン", width: "共通", file: "", result: "失敗", note: safeReason(error) });
} finally {
  // 以降の処理では資格情報を保持しない。
}

if (loginReady) {
  try { await discover(); } catch { /* 対象がない旨を各画面へ記録する */ }
  await discoverPublished();
  await discoverPrint();
  for (const shot of shots) {
    for (const width of shot.a4 ? [1280] : widths) await capture(shot, width);
  }
} else {
  for (const shot of shots) {
    for (const width of shot.a4 ? [1280] : widths) {
      const suffix = shot.a4 && width === 1280 ? "794" : String(width);
      rows.push({ stage: shot.stage, name: shot.name, width: suffix, file: `${shot.name}-${suffix}.png`, result: "未撮影", note: "役員ログインできませんでした" });
    }
  }
}

if (browserReady) await browser.close();
const ordered = rows.sort((a, b) => a.stage - b.stage || shots.findIndex((shot) => shot.name === a.name) - shots.findIndex((shot) => shot.name === b.name) || a.width.localeCompare(b.width));
const lines = [
  "# 画面撮影一覧",
  "",
  `- 区: ${ward}`,
  `- 対象プロジェクト: ${projectId || "見つかりませんでした"}`,
  "- 資格情報: 値は表示・記録していません",
  "- PC 動画の元: 幅 1280 の画面画像。印刷用ページは A4 幅 794 px。",
  "",
  "| 段 | 画面 | 幅 | ファイル | 結果 | メモ |",
  "|---:|---|---:|---|---|---|",
  ...ordered.map((row) => `| ${row.stage} | ${row.name} | ${row.width} | ${row.file ? `\`${row.file}\`` : "—"} | ${row.result} | ${row.note || "—"} |`),
  "",
];
writeFileSync(resolve(out, "index.md"), lines.join("\n"), "utf8");
console.log(`撮影一覧を書きました: ${resolve(out, "index.md")}`);
