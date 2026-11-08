/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 匿名で読める画面だけを開く。フォームは送らず、本文や入力値は報告へ写さない。
// node scripts/check-reading.ts --base <URL> --ward <区のURL名> --project <行事ID> --out <報告.md>
// node scripts/check-reading.ts --self-test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

type Finding = { item: string; selector: string; detail: string };
type Result = { path: string; width: number; findings: Finding[]; uncheckedContrast: number };
const widths = [390, 1280];

async function inspect(page: Page) {
  return page.evaluate(() => {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    let uncheckedContrast = 0;
    const visible = (element: Element) => {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !element.getClientRects().length) return false;
      for (let at: Element | null = element; at; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const selector = (element: Element): string => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parent = element.parentElement;
      const position = parent ? [...parent.children].filter((child) => child.tagName === element.tagName).indexOf(element) + 1 : 1;
      return `${parent && parent !== document.body ? selector(parent) + " > " : ""}${element.tagName.toLowerCase()}:nth-of-type(${position})`;
    };
    const add = (item: string, element: Element, detail: string) => {
      const where = selector(element);
      const key = `${item}:${where}`;
      if (!seen.has(key)) { seen.add(key); findings.push({ item, selector: where, detail }); }
    };
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible);
    if (!headings.some((heading) => heading.tagName === "H1")) add("見出しの順", document.body, "h1がありません");
    let level = 0;
    for (const heading of headings) {
      const next = Number(heading.tagName.slice(1));
      if (next > level + 1) add("見出しの順", heading, `h${level || 1}の次がh${next}です`);
      level = next;
    }
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]),select,textarea")].filter(visible);
    for (const field of fields) {
      const labelledBy = (field.getAttribute("aria-labelledby") ?? "").split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim());
      const named = field.getAttribute("aria-label")?.trim() || labelledBy || [...(field.labels ?? [])].some((label) => label.textContent?.trim());
      if (!named) add("欄の名前", field, "欄に結び付いたlabelかaria-labelがありません");
    }
    type Color = [number, number, number, number];
    const color = (value: string): Color | null => {
      if (!value.startsWith("rgb")) return null;
      const values = value.match(/[\d.]+/g)?.map(Number);
      return values && values.length >= 3 ? [values[0]!, values[1]!, values[2]!, values[3] ?? 1] : null;
    };
    const over = (top: Color, bottom: Color): Color => [
      top[0] * top[3] + bottom[0] * (1 - top[3]), top[1] * top[3] + bottom[1] * (1 - top[3]), top[2] * top[3] + bottom[2] * (1 - top[3]), 1,
    ];
    const luminance = (value: Color) => value.slice(0, 3).map((part) => {
      const s = part / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index]!, 0);
    const background = (element: Element): Color | null => {
      const chain: Element[] = [];
      for (let at: Element | null = element; at; at = at.parentElement) chain.unshift(at);
      let value: Color = [255, 255, 255, 1];
      for (const at of chain) {
        const style = getComputedStyle(at);
        if (style.backgroundImage !== "none" || Number(style.opacity) !== 1) return null;
        const next = color(style.backgroundColor);
        if (!next) return null;
        value = over(next, value);
      }
      return value;
    };
    const textElements = new Set<Element>(fields);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const element = walker.currentNode.parentElement;
      if (walker.currentNode.textContent?.trim() && element && visible(element) && !element.closest("script,style,svg,.sheet,.print,[data-print]")) textElements.add(element);
    }
    for (const element of textElements) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element), size = Number.parseFloat(style.fontSize);
      if (size < 18) add("文字の大きさ", element, `${size}px（18px未満）`);
      if (element.matches(":disabled")) continue;
      const foreground = color(style.color), bg = background(element);
      if (!foreground || !bg) { uncheckedContrast++; continue; }
      const a = luminance(over(foreground, bg)), b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const minimum = size >= 24 || (size >= 18.66 && Number.parseInt(style.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio < minimum) add("文字と背景の色の差", element, `${ratio.toFixed(2)}:1（必要な${minimum}:1未満）`);
    }
    const controls = [...document.querySelectorAll<HTMLElement>("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[onclick]")]
      .filter((element) => visible(element) && !element.matches(":disabled"));
    const keyboard = controls.filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return true;
      // ラジオの組は選択中（なければ先頭）の一つがTabの入口。ほかは矢印キーで選ぶ。
      const group = controls.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.type === "radio" && other.name === element.name && other.form === element.form);
      return (group.find((other) => other.checked) ?? group[0]) === element;
    });
    keyboard.forEach((element, index) => element.setAttribute("data-reading-key", String(index)));
    return { findings, uncheckedContrast, keyboard: keyboard.map(selector) };
  });
}

async function checkPage(browser: Browser, url: URL, width: number): Promise<Result> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: "light" });
  await context.route("**/*", (route) => {
    const request = route.request(), target = new URL(request.url());
    const allowed = ["GET", "HEAD"].includes(request.method()) && target.origin === url.origin
      && !/\/(?:admin|ops|enter|join|person|logout|delete)(?:\/|$)/.test(target.pathname)
      && (!request.isNavigationRequest() || target.pathname === url.pathname);
    return allowed ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const result: Result = { path: url.pathname, width, findings: [], uncheckedContrast: 0 };
  try {
    const response = await page.goto(url.href, { waitUntil: "networkidle", timeout: 20000 });
    if (!response?.ok()) result.findings.push({ item: "画面を開く", selector: "", detail: `HTTP ${response?.status() ?? "応答なし"}` });
    // 閉じた説明の中も調べる。表示だけを変え、送信や画面の移動は行わない。
    await page.locator("details").evaluateAll((elements) => elements.forEach((element) => {
      if (element instanceof HTMLDetailsElement) element.open = true;
    }));
    const checked = await inspect(page);
    result.findings.push(...checked.findings);
    result.uncheckedContrast = checked.uncheckedContrast;
    const reached = new Set<number>();
    for (let step = 0; step < checked.keyboard.length * 2 + 3 && reached.size < checked.keyboard.length; step++) {
      await page.keyboard.press("Tab");
      const index = await page.evaluate(() => document.activeElement?.getAttribute("data-reading-key"));
      if (index !== null && index !== undefined) reached.add(Number(index));
    }
    checked.keyboard.forEach((selector, index) => {
      if (!reached.has(index)) result.findings.push({ item: "キーボード", selector, detail: "Tabでこの操作へ移れません" });
    });
  } catch {
    result.findings.push({ item: "画面を開く", selector: "", detail: "画面の確認を完了できませんでした" });
  } finally { await context.close(); }
  return result;
}

function report(results: Result[]) {
  const failures = results.flatMap((result) => result.findings.map((finding) => ({ ...finding, path: result.path, width: result.width })));
  return ["# 公開の画面の読みやすさ", "", `確認${results.length}件、不合格${failures.length}件。幅390pxと1280pxで確認します。`, "",
    "GETだけで固定の画面を開き、折り畳んだ説明を開いて調べます。フォームは送りません。入力値や本文を報告へ写しません。", "",
    "文字は18px以上、文字と背景は通常4.5:1以上、大きな文字は3:1以上を確かめます。画像の背景・半透明のまとまりの色の差は未確認です。",
    "キーボードはTabで操作へ移れるかを確かめます。保存や送信の作動、外の埋め込み画面、読み上げでの聞こえ方は未確認です。", "",
    `色の差を計算できなかった箇所: ${results.reduce((sum, result) => sum + result.uncheckedContrast, 0)}件。`, "",
    "| 画面 | 幅 | 項目 | 箇所 | 結果 |", "|---|---:|---|---|---|",
    ...failures.map((failure) => `| ${failure.path} | ${failure.width} | ${failure.item} | ${failure.selector.replaceAll("|", "\\|")} | ${failure.detail} |`), "",
  ].join("\n");
}

async function selfTest() {
  const requests: string[] = [];
  const html = (body: string) => `<!doctype html><html lang="ja"><style>body{font-size:18px;color:#000;background:#fff}input,button{font-size:18px}</style><body>${body}</body></html>`;
  const server = createServer((request, response) => {
    requests.push(request.method ?? "");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html(request.url === "/bad" ? '<h1>試しの画面</h1><h3>飛ばした見出し</h3><input placeholder="名前だけ" value="fictional-value-must-not-be-reported"><p style="font-size:14px">小さい字</p><p style="color:#aaa">色の差の小さい字</p><span role="button" tabindex="-1" onclick="void 0">届かない操作</span>'
      : '<h1>試しの画面</h1><h2>入力してください</h2><form><label for="name">名前</label><input id="name"><label><input type="radio" name="kind" checked>参加</label><label><input type="radio" name="kind">欠席</label><button>送る</button></form><details><summary>説明を読む</summary><label>補足<input></label><a href="/good">戻る</a></details>'));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("試しの画面を開けません");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const results: Result[] = [];
    for (const width of widths) {
      const good = await checkPage(browser, new URL(`http://127.0.0.1:${address.port}/good`), width);
      assert.deepEqual(good.findings, []);
      const bad = await checkPage(browser, new URL(`http://127.0.0.1:${address.port}/bad`), width);
      for (const item of ["見出しの順", "欄の名前", "文字の大きさ", "文字と背景の色の差", "キーボード"]) assert.ok(bad.findings.some((finding) => finding.item === item), item);
      results.push(good, bad);
    }
    assert.ok(requests.every((method) => method === "GET"));
    assert.ok(!report(results).includes("fictional-value-must-not-be-reported"));
    console.log("試しの2画面・2つの幅で5項目を確認しました。自己試験成功。");
  } finally { await browser?.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const value = (name: string) => {
    const index = args.indexOf(name), next = args[index + 1];
    return index >= 0 && next && !next.startsWith("--") ? next : undefined;
  };
  const base = value("--base"), ward = value("--ward"), project = value("--project"), out = value("--out");
  if (!base || !ward || !project || !out || !/^[A-Za-z0-9_-]+$/.test(ward) || !/^[A-Za-z0-9_-]+$/.test(project)) throw new Error("--base <URL> --ward <区のURL名> --project <行事ID> --out <報告.md>が必要です");
  const root = new URL(base);
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password || root.search || root.hash || root.pathname !== "/") throw new Error("--baseには認証情報やパスを含まない画面の根のURLを指定してください");
  const paths = [`/${ward}/`, `/${ward}/p/${project}`, `/${ward}/answer/${project}`, `/${ward}/help/${project}`, `/${ward}/space/${project}`, "/contact"];
  const browser = await chromium.launch({ headless: true });
  const results: Result[] = [];
  try { for (const path of paths) for (const width of widths) results.push(await checkPage(browser, new URL(path, root), width)); }
  finally { await browser.close(); }
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, report(results), "utf8");
  const failures = results.reduce((sum, result) => sum + result.findings.length, 0);
  console.log(`${paths.length}画面・${results.length}件、不合格${failures}件。報告: ${target}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "確認できませんでした"); process.exitCode = 2; });
