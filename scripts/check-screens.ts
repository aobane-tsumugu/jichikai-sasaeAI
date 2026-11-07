/// <reference lib="dom" />
// ログインだけを例外にし、読むだけの画面をたどって見え方を確かめる。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { Page } from "playwright";

type Options = { base: string; ward: string; creds: string; out: string; project?: string; meetingProject?: string; dutyProject?: string };
type Failure = { item: string; detail: string };
type Result = { path: string; width: number | "共通"; failures: Failure[]; primaryChecked?: boolean };
const widths = [390, 1280];
const limit = 200;

// 読むだけの画面の形。同じ形は一つにまとめ、更新用の入口へ進まない。
const screens = [
  "/admin", "/admin/projects", "/admin/projects/today",
  "/admin/projects/:project", "/admin/projects/:project/questions",
  "/admin/projects/:project/map", "/admin/projects/:project/map/:task",
  "/admin/projects/:project/ledger", "/admin/projects/:project/ledger/:row",
  "/admin/projects/:project/draft", "/admin/projects/:project/draft/:kind",
  "/admin/publish/:project", "/admin/projects/:project/questions/:question/compare",
  "/admin/print/:project/:document/:version/preview",
  "/admin/publish/:project/confirm", "/admin/print/:project",
  "/admin/print/:project/paper/:kind", "/admin/print/:project/:document/:version",
  "/admin/print/:project/:document/:version/:kind",
  "/admin/answers", "/admin/answers/roster", "/admin/answers/:project",
  "/admin/answers/:project/:answer/edit", "/admin/space/:project", "/admin/close/:project",
  "/admin/projects/:project/committee", "/admin/rota/exemptions", "/admin/rota/history", "/admin/rota/:project/result",
  "/admin/intake", "/admin/intake/received", "/admin/intake/read", "/admin/intake/started/:project",
  "/admin/inbox", "/admin/inbox/questions", "/admin/archive", "/admin/know", "/admin/know/:item", "/admin/files", "/admin/year", "/admin/year/:key",
  "/admin/inbox/:item/pick", "/admin/inbox/city/:job/pick",
  "/admin/archive/search", "/admin/archive/:project", "/admin/settings",
  "/admin/settings/people", "/admin/settings/info", "/admin/settings/deletion",
  "/admin/settings/templates", "/admin/inquiries", "/admin/inquiries/:inquiry", "/admin/inquiries/:inquiry/original", "/admin/requests/city",
  "/admin/requests/city/:project", "/admin/ledger",
  "", "/help", "/help/:project", "/p/:project", "/answer/:project",
  "/space/:project",
  "/q/:project/:document/:version", "/work/:project",
];
const routes = screens.map((shape) => ({
  shape,
  pattern: new RegExp(`^${shape.replace(/:[a-z]+/g, "[^/]+")}$`),
}));
const unsafePart = /^(?:logout|delete|remove|withdraw|unpublish|revoke|reset|publish|close|send|save|restore|reopen|open|invite|join|person|enter|cancel|stop|drop|distribute)$/i;
const unsafeQuery = /^(?:action|operation|method|token|key|password|secret|invite|delete|remove|logout|publish|close|send|save|restore|reopen|open|withdraw|unpublish|confirm)$/i;

function scope(options: Options) {
  const base = new URL(options.base);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("--baseは資格情報やパスを含まないhttpまたはhttpsのURLを指定してください。");
  }
  if (!options.ward || /[/\\?#\s]/.test(options.ward) || [".", ".."].includes(options.ward)) {
    throw new Error("--wardに自治会のURLの名前を指定してください。");
  }
  const wardPath = `/${encodeURIComponent(options.ward)}`;
  const loginPath = `${wardPath}/admin/login`;
  function relative(url: URL): string | null {
    if (url.origin !== base.origin || url.username || url.password) return null;
    if (url.pathname !== wardPath && !url.pathname.startsWith(`${wardPath}/`)) return null;
    return url.pathname.slice(wardPath.length).replace(/\/+$/, "");
  }
  function match(url: URL) {
    const path = relative(url);
    if (path === null) return undefined;
    // 配る・閉じる「画面」は読む。さらに下にある更新用の入口は読まない。
    let parts: string[];
    try { parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
    catch { return undefined; }
    if (parts.some((part, i) => unsafePart.test(part) && !(i === 1 && parts[0] === "admin" && ["publish", "close"].includes(part)))) return undefined;
    if ([...url.searchParams.keys()].some((key) => unsafeQuery.test(key))) return undefined;
    return routes.find((route) => route.pattern.test(path));
  }
  function candidate(href: string, from: string) {
    try {
      const url = new URL(href, from);
      if (!match(url)) return undefined;
      url.hash = "";
      return url;
    } catch { return undefined; }
  }
  function screenQuery(url: URL): string {
    const route = match(url)?.shape ?? "";
    const views: Record<string, readonly string[]> = {
      "/admin/answers/:project": ["send", "sent", "hand", "list", "read", "helpers", "unanswered"],
      "/admin/archive/:project": ["seed"],
      "/admin/close/:project": ["activity"],
    };
    const query = new URLSearchParams();
    const view = url.searchParams.get("view");
    if (view && views[route]?.includes(view)) query.set("view", view);
    if (route === "/admin/answers/:project" && view === "unanswered" && url.searchParams.get("print") === "1") query.set("print", "1");
    if (route === "/admin/projects/:project/draft/:kind" && relative(url)?.endsWith("/draft/notice") && url.searchParams.get("edit") === "1") query.set("edit", "1");
    // 検索語や入力内容は、画面の識別にも報告にも使わない。
    return query.size ? `?${query.toString()}` : "";
  }
  function projectKind(url: URL) {
    const index = match(url)?.shape.split("/").indexOf(":project") ?? -1;
    const id = index >= 0 ? relative(url)?.split("/")[index] : undefined;
    if (id && id === encodeURIComponent(options.meetingProject ?? "")) return "総会";
    if (id && id === encodeURIComponent(options.dutyProject ?? "")) return "当番";
    return "";
  }
  function shape(url: URL): string {
    const route = match(url);
    // 下書きの種類と印刷の種類は別の画面。IDとページ番号、検索語はまとめる。
    const actual = relative(url)?.split("/") ?? [];
    const parts = route?.shape.split("/").map((part, index) => part === ":kind" ? actual[index] : part);
    return `${wardPath}${parts?.join("/") ?? "/対象外"}${screenQuery(url)}${projectKind(url)}`;
  }
  function primaryRule(url: URL) {
    const route = match(url)?.shape ?? "";
    // 追加画面には配置の見本を当てていない。共通検査は続け、ボタンの位置・数は判定しない。
    return !projectKind(url) && !route.includes("/rota/") && !route.endsWith("/committee") && !route.endsWith("/pick");
  }
  const displayPath = (url: URL) => url.pathname + screenQuery(url);
  return { base, wardPath, loginPath, relative, match, candidate, shape, displayPath, primaryRule };
}

function readCredentials(path: string) {
  const contents = readFileSync(resolve(path), "utf8");
  const loginId = /^(?:ID|ログインID)\s*[:：]\s*(.+)$/m.exec(contents)?.[1]?.trim();
  const name = /^(?:名前|氏名)\s*[:：]\s*(.+)$/m.exec(contents)?.[1]?.trim() ?? loginId;
  const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(contents)?.[1]?.trim();
  if (!name || !password) throw new Error("資格情報は「名前:」（または「ID:」）と「パスワード:」形式で指定してください。");
  return { name, password, loginId };
}

function reason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "表示を待つ時間が上限に達しました";
  // 例外の本文にはURLや資格情報が入りうるため、そのまま出さない。
  return "画面を開けませんでした";
}

function errorHead(message: string, kind: "console.error" | "pageerror"): string {
  // ブラウザーの定型の診断だけを残す。引用された本文、URL、名前、鍵、任意のログは写さない。
  const resource = /^Failed to load resource: (?:net::ERR_[A-Z_]+|the server responded with a status of \d{3})/.exec(message)?.[0];
  const csp = /^(?:Refused to (?:execute|apply|load|connect to|frame)|(?:Executing|Applying|Loading|Connecting to|Framing) (?:the )?(?:inline script|inline style|script|stylesheet))\b/.exec(message)?.[0];
  const exception = /^(?:Uncaught )?(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)\b/.exec(message)?.[0];
  return (resource ?? (csp && /Content Security Policy|script-src|style-src/.test(message) ? `${csp} [対象を伏せました] (Content Security Policy)` : exception ? `${exception}: [本文を伏せました]` : `${kind}: [本文を伏せました]`)).slice(0, 100);
}

async function inspect(page: Page, primaryChecked: boolean): Promise<Failure[]> {
  return page.evaluate((primaryChecked) => {
    const failures: Array<{ item: string; detail: string }> = [];
    const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && element.getClientRects().length > 0;
    // 本文や名前、フォームの値を報告へ写さず、要素の場所で示す。
    function location(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.tagName !== "BODY" && parts.length < 6) {
        const tag = current.tagName.toLowerCase();
        const siblings: Element[] = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current?.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return parts.join(" > ") || "body";
    }
    function add(item: string, details: string[]) {
      if (details.length) failures.push({ item, detail: `${details.length}件: ${details.slice(0, 8).join(" / ")}${details.length > 8 ? " / 以降省略" : ""}` });
    }
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (scrollWidth > innerWidth) failures.push({ item: "横のはみ出し", detail: `${scrollWidth}px（画面${innerWidth}px）` });

    const textElements = Array.from(document.body.querySelectorAll("*"));
    const small: string[] = [];
    for (const element of [document.body, ...textElements]) {
      if (element.closest("svg, .sheet, .print, [data-print], script, style, noscript, template") || !visible(element)) continue;
      const directText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      const fieldText = element instanceof HTMLInputElement && element.type !== "password" ? `${element.value} ${element.placeholder}`.trim()
        : element instanceof HTMLTextAreaElement ? `${element.value} ${element.placeholder}`.trim()
        : element instanceof HTMLSelectElement ? Array.from(element.selectedOptions).map((option) => option.text).join("") : "";
      if (!directText && !fieldText) continue;
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < 18) small.push(`${location(element)}（${size}px）`);
    }
    add("文字が18px未満", small);

    const controls = Array.from(document.body.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]'));
    const short: string[] = [];
    const measured = new Set<Element>();
    for (const element of controls) {
      if (!visible(element) || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") continue;
      if (element.hasAttribute("tabindex") && !element.matches("a, button, input, select, textarea, summary, [role=button]") && Number(element.getAttribute("tabindex")) < 0) continue;
      if (element.matches("a:not(.button):not(.quiet):not(.row-link):not(.back)")) {
        const paragraph = element.closest("p, li, dd, td, label");
        if (getComputedStyle(element).display === "inline" && paragraph && (paragraph.textContent ?? "").replace(element.textContent ?? "", "").trim()) continue;
      }
      // チェック欄は、実際に押せるラベル全体の高さを見る。
      const label = element instanceof HTMLInputElement && ["checkbox", "radio", "file"].includes(element.type)
        ? Array.from(element.labels ?? []).find(visible) : undefined;
      const target = label ?? element;
      if (measured.has(target)) continue;
      measured.add(target);
      const height = target.getBoundingClientRect().height;
      if (height < 48) short.push(`${location(target)}（${Number(height.toFixed(1))}px）`);
    }
    add("押せるものの高さが48px未満", short);

    const primary = Array.from(document.body.querySelectorAll(".button, button"))
      .filter((element) => !element.matches(".secondary, .quiet, :disabled, [aria-disabled=true]") && visible(element));
    const first = primary[0];
    if (primaryChecked && first) {
      const rect = first.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
        failures.push({ item: "主なボタンが一画面目に見えない", detail: `${location(first)}（上${Math.round(rect.top)}px、下${Math.round(rect.bottom)}px、画面の高さ${innerHeight}px）` });
      }
    }
    if (primaryChecked && primary.length > 1) failures.push({ item: "主なボタンが二つ以上", detail: `${primary.length}件: ${primary.slice(0, 8).map(location).join(" / ")}` });

    // innerTextは閉じた説明やscriptを含めない。入力中の文字も画面の文字として見る。
    const shown = document.body.innerText + controls.filter(visible).map((element) => {
      if (element instanceof HTMLInputElement && element.type !== "password") return `${element.value} ${element.placeholder}`;
      if (element instanceof HTMLTextAreaElement) return `${element.value} ${element.placeholder}`;
      return "";
    }).join("\n");
    const invalid = ["undefined", "null", "[object", "NaN"].filter((word) => shown.includes(word));
    if (invalid.length) failures.push({ item: "文字の表示の誤り", detail: invalid.join("、") });
    return failures;
  }, primaryChecked);
}

async function check(options: Options): Promise<{ results: Result[]; project: string; capped: boolean }> {
  const site = scope(options);
  const credentials = readCredentials(options.creds);
  const results: Result[] = [];
  const browser = await chromium.launch({ headless: true });
  let project = options.project ?? "";
  let capped = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    let loggingIn = true;
    let loginPosted = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const login = url.origin === site.base.origin && url.pathname === site.loginPath && !url.search;
      if (loggingIn && login && request.method() === "POST" && !loginPosted) {
        loginPosted = true;
        await route.continue();
        return;
      }
      const resource = site.relative(url);
      const original = resource !== null && /^\/admin\/(?:intake\/originals\/[^/]+|inbox\/[^/]+\/original)$/.test(resource);
      // ページごとの自動アイコン取得をabortすると、道具自身の通信エラーがconsoleに残る。
      if (request.method() === "GET" && url.origin === site.base.origin && url.pathname === "/favicon.ico") {
        await route.fulfill({ status: 204 });
        return;
      }
      const asset = url.origin === site.base.origin && (resource !== null || /^\/(?:assets|cdn-cgi)\//.test(url.pathname))
        && /\.(?:js|css|woff2?|ttf|ico|png|jpe?g|gif|svg|webp)$/i.test(url.pathname)
        && ["script", "stylesheet", "font", "image"].includes(request.resourceType());
      if (request.method() !== "GET" || !(site.match(url) || original || asset || (loggingIn && login))) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(new URL(site.loginPath, site.base).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (credentials.loginId && await page.locator('input[name="loginId"]').count()) {
      await page.locator('input[name="loginId"]').fill(credentials.loginId);
      await page.locator('input[name="password"]').fill(credentials.password);
      await page.getByRole("button", { name: "ログインする", exact: true }).click();
      await page.waitForURL((url) => url.pathname !== site.loginPath, { timeout: 15000 });
    } else {
      // walkthrough.tsと同じ、名前で入る区の入口。APIRequestは同じCookieを使う。
      loginPosted = true;
      const response = await context.request.post(new URL(site.loginPath, site.base).href, {
        form: { name: credentials.name, password: credentials.password }, headers: { origin: site.base.origin }, maxRedirects: 0,
      });
      if (response.status() !== 303) throw new Error("役員画面に入れませんでした");
      await page.goto(new URL(`${site.wardPath}/admin/`, site.base).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    if (!site.match(new URL(page.url()))) throw new Error("役員画面に入れませんでした");
    loggingIn = false;

    const list = new URL(`${site.wardPath}/admin/projects`, site.base);
    async function projectFromPage() {
      const hrefs = await page.locator("a[href]").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
      for (const href of hrefs) {
        const url = site.candidate(href, page.url());
        if (url && ["/admin/projects/:project", "/admin/projects/:project/map"].includes(site.match(url)?.shape ?? "")) {
          return decodeURIComponent(site.relative(url)?.split("/")[3] ?? "");
        }
      }
      return "";
    }
    // 今の「新しく始める」画面は開いた仕事の一覧ではない。最初の画面の段取りへのリンクを先に使う。
    if (!project) project = await projectFromPage();
    if (!project) {
      // 古い一覧にも対応し、閉じた記録へは切り替えない。
      try {
        const response = await page.goto(list.href, { waitUntil: "load", timeout: 30000 });
        if (!response?.ok() || !site.match(new URL(page.url()))) throw new Error();
        project = await projectFromPage();
      } catch {
        results.push({ path: `${site.wardPath}/admin/projects`, width: "共通", failures: [{ item: "行事の選択", detail: "開いている行事の一覧を読めませんでした" }] });
      }
    }

    const queue: URL[] = [];
    const seen = new Set<string>();
    function enqueue(href: string, from: string) {
      const url = site.candidate(href, from);
      if (!url) return;
      // 行き先を決める古い道は、トークの画面へ送るだけになった。着く先のトークの画面で確かめる。
      if (/\/inbox\/(?:city\/)?[^/]+\/pick$/.test(url.pathname)) return;
      const shape = site.shape(url);
      if (seen.has(shape)) return;
      if (queue.length >= limit) { capped = true; return; }
      seen.add(shape);
      queue.push(url);
    }
    if (project) {
      // 実行委員の入口は、開いているときだけ設定画面に出るリンクからたどる。
      for (const path of [`/admin/projects/${encodeURIComponent(project)}`, `/answer/${encodeURIComponent(project)}`, `/help/${encodeURIComponent(project)}`, `/admin/space/${encodeURIComponent(project)}`]) {
        enqueue(`${site.wardPath}${path}`, site.base.href);
      }
    }
    // 種類で画面が変わるので、通常の行事と同じ形のURLでも別々に読む。
    if (options.meetingProject) {
      const id = encodeURIComponent(options.meetingProject);
      for (const path of [`/admin/answers/${id}`, `/answer/${id}`, `/admin/projects/${id}/committee`,
        ...["hand", "list", "read", "send", "sent", "unanswered"].map((view) => `/admin/answers/${id}?view=${view}`)]) enqueue(`${site.wardPath}${path}`, site.base.href);
    }
    if (options.dutyProject) {
      const id = encodeURIComponent(options.dutyProject);
      enqueue(`${site.wardPath}/admin/projects/${id}/draft/duty_roster`, site.base.href);
      enqueue(`${site.wardPath}/admin/rota/${id}/result`, site.base.href);
    }
    for (const path of ["/admin/rota/exemptions", "/admin/rota/history", "/admin/answers"]) enqueue(`${site.wardPath}${path}`, site.base.href);
    enqueue(`${site.wardPath}/admin/`, site.base.href);
    enqueue(`${site.wardPath}/`, site.base.href);
    enqueue(`${site.wardPath}/help`, site.base.href);
    enqueue(list.href, site.base.href);

    for (const [index, url] of queue.entries()) {
      console.log(`画面を確認中: ${index + 1}/${queue.length}`);
      for (const width of widths) {
        // 画面ごとに新しく開き、前の画面のconsoleや通信を混ぜない。
        let view: Page | undefined;
        const failures: Failure[] = [];
        const httpErrors = new Set<string>();
        const consoleErrors: string[] = [];
        try {
          view = await context.newPage();
          view.on("console", (message) => { if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) consoleErrors.push(errorHead(message.text(), "console.error")); });
          view.on("pageerror", (error) => { consoleErrors.push(errorHead(error.message, "pageerror")); });
          view.on("response", (response) => {
            if (response.status() >= 400) httpErrors.add(`HTTP ${response.status()}（${response.request().resourceType()}）`);
          });
          await view.setViewportSize({ width, height: width === 390 ? 844 : 800 });
          const response = await view.goto(url.href, { waitUntil: "load", timeout: 30000 });
          if (!response) throw new Error();
          if (!site.match(new URL(view.url()))) throw new Error();
          if (!(response.headers()["content-type"] ?? "").includes("text/html")) throw new Error();
          await view.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
          await view.waitForTimeout(250);
          failures.push(...await inspect(view, site.primaryRule(url)));
          const hrefs = await view.locator("a[href]:not([download])").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
          for (const href of hrefs) enqueue(href, view.url());
        } catch (error) {
          failures.push({ item: "表示できない", detail: reason(error) });
        } finally {
          for (const error of httpErrors) failures.push({ item: "HTTPの誤り", detail: error });
          if (consoleErrors.length) failures.push({ item: "JavaScriptの誤り（console.errorなど）", detail: `${consoleErrors.length}件: ${[...new Set(consoleErrors)].slice(0, 8).join(" / ")}` });
          results.push({ path: site.displayPath(url), width, failures, primaryChecked: site.primaryRule(url) });
          if (view) {
            try { await view.close(); }
            catch { failures.push({ item: "ブラウザーの終了", detail: "この画面を閉じる処理に失敗しました" }); }
          }
        }
      }
    }
    return { results, project, capped };
  } finally {
    await browser.close();
  }
}

function report(options: Options, results: Result[], project: string, capped: boolean) {
  const paths = [...new Set(results.filter((row) => typeof row.width === "number").map((row) => row.path))];
  const passed = paths.filter((path) => widths.every((width) => results.some((row) => row.path === path && row.width === width && !row.failures.length))).length;
  const cell = (value: string | number) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]/g, " ");
  const basicOnly = [...new Set(results.filter((row) => row.primaryChecked === false).map((row) => row.path))];
  const lines = [
    "# 画面の確かめ", "",
    `- 確認日時: ${new Date().toISOString()}`,
    `- 対象: ${cell(new URL(options.base).origin)}/${cell(encodeURIComponent(options.ward))}/`,
    `- 行事: ${cell(project || "開いている行事を選べませんでした。区とリンク先の画面を確認します")}`,
    `- 総会: ${cell(options.meetingProject ?? "指定なし")}, 当番: ${cell(options.dutyProject ?? "指定なし")}`,
    `- 通った画面: ${passed}/${paths.length}画面（両方の幅で適用した検査項目を通過）`,
    `- 幅ごとの結果: 通過${results.filter((row) => typeof row.width === "number" && !row.failures.length).length}件、不合格${results.filter((row) => row.failures.length).length}件`,
    `- 幅390pxは高さ844px、幅1280pxは高さ800px。主なボタンのない画面ではボタンの位置を検査しません。`,
    "- 種類・表示が同じ形のURLは一つ。下書きと印刷の種類、入力や一覧への切り替えは別々。検索語などの違いはまとめます。",
    "- --meeting-projectと--duty-projectで指定した種類は、通常の行事と同じ形のURLでも別々に調べます。未指定の種類の画面を確認済みとはしません。",
    "- 見本との画像比較は行いません。追加画面は文字・押す面・はみ出し・表示エラー・通信・JavaScriptの共通検査を行い、見本に依存する主なボタンの位置・数を判定しません。従来の画面の判定は維持します。",
    `- ${!paths.length ? "画面を確認できていません。下の実行結果を確認してください。" : capped ? "上限200画面に達しました。残りのリンク先は未確認です。" : "集めたリンク先を最後まで確認しました。"}`,
    "- ログインだけPOSTを一回使います。既存の認証処理による端末の記録を除き、GETの画面だけを開きます。招待を使う入口と更新用の入口へは進みません。",
    "- 文字の大きさは表示中の本文と入力欄を対象にし、印刷の中身（.sheet、.print、[data-print]）とSVGを除きます。本文に埋め込まれたリンクの高さは除きます。",
    "- 本文と資格情報は保存しません。JavaScriptの誤りは、ブラウザーの定型の診断だけを残して対象や本文を伏せ、冒頭100文字以内を記録します。任意のログの本文は伏せます。不合格だけを次に記録します。", "",
    ...basicOnly.map((path) => `- 主なボタンの位置・数は未判定: ${cell(path)}`), "",
    "| 画面のURL | 幅 | 落ちた項目 | 場所と内容 |", "|---|---:|---|---|",
    ...results.flatMap((row) => row.failures.map((failure) => `| ${cell(row.path)} | ${cell(row.width)} | ${cell(failure.item)} | ${cell(failure.detail)} |`)), "",
    // 前の回と比べて、どこからも届かなくなった画面を見つけるために、確かめた画面を並べる。ID は形だけにする。
    "", "## 確かめた画面", "",
    ...paths.map((path) => `- ${cell(path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"))}`).sort(),
  ];
  mkdirSync(resolve(options.out), { recursive: true });
  writeFileSync(resolve(options.out, "report.md"), lines.join("\n"), "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (key: string) => {
    const index = args.indexOf(key);
    return index >= 0 ? args[index + 1] : args.find((value) => value.startsWith(`${key}=`))?.slice(key.length + 1);
  };
  const base = arg("--base"), ward = arg("--ward"), creds = arg("--creds"), out = arg("--out");
  if (!base || !ward || !creds || !out) {
    console.error("使い方: npm run check-screens -- --base <URL> --ward <区> --creds <資格情報のファイル> --out <フォルダ> [--project <行事ID> --meeting-project <総会ID> --duty-project <当番ID>]");
    process.exitCode = 2;
    return;
  }
  const options: Options = { base, ward, creds, out, project: arg("--project"), meetingProject: arg("--meeting-project"), dutyProject: arg("--duty-project") };
  try { scope(options); } catch (error) {
    console.error(error instanceof Error ? error.message : "引数を確認してください。");
    process.exitCode = 2;
    return;
  }
  try {
    const { results, project, capped } = await check(options);
    report(options, results, project, capped);
    process.exitCode = results.some((row) => row.failures.length) || capped ? 1 : 0;
  } catch {
    report(options, [{ path: "開始", width: "共通", failures: [{ item: "開始できない", detail: "資格情報の形式、役員の入り口、PlaywrightのChromiumが使えるかを確認してください" }] }], "", false);
    process.exitCode = 2;
  }
  console.log("指定したフォルダのreport.mdに結果を書きました。");
}

// 主な流れの試験。外側から実行する。
async function selfTest() {
  const { test } = await import("node:test");
  const { createServer } = await import("node:http");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const spaceOpen of [false, true]) await test(`架空の区で画面を集め、更新と別の区へ進まない（実行委員のページ${spaceOpen ? "開設済み" : "未開設"}）`, async () => {
    const temp = mkdtempSync(resolve(tmpdir(), "check-screens-"));
    const requests: string[] = [];
    const html = (body: string) => `<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.ico"><style>body{margin:0;font-size:18px}a,button,input,summary{display:block;min-height:48px;font-size:18px}.small{font-size:12px}.wide{width:1400px}</style><script nonce="fixture" src="/fixture/app.js"></script></head><body>${body}</body></html>`;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      requests.push(`${request.method} ${path}${url.search}`);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", "script-src 'nonce-fixture'; style-src 'unsafe-inline'");
      if (path === "/fixture/app.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end("document.documentElement.dataset.fixture = 'loaded';");
      } else if (path === "/fixture/admin/login") {
        if (request.method === "POST") {
          let body = "";
          request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
          request.on("end", () => {
            const form = new URLSearchParams(body);
            const valid = form.get("name") === "架空の役員" && form.get("password") === "fictional-only"
              && request.headers.origin === `http://${request.headers.host}`;
            response.writeHead(valid ? 303 : 403, valid ? { Location: "/fixture/admin/", "Set-Cookie": "device=fictional; Path=/fixture/admin; HttpOnly" } : {});
            response.end();
          });
        } else response.end(html('<form method="post"><input name="loginId"><input name="password" type="password"><button>ログインする</button></form>'));
      } else if (path.startsWith("/fixture/admin") && !request.headers.cookie?.includes("device=fictional")) {
        response.writeHead(403); response.end(html("役員用です"));
      } else if (path === "/fixture/admin/") {
        response.end(html('<a href="/fixture/admin/projects/first/map">架空の行事のやること</a><a href="/fixture/admin/archive/old">去年の終わったもの</a>'));
      } else if (path === "/fixture/answer/first") {
        response.end(html('<main><h1>架空の行事の出欠を教えてください</h1><form method="post"><label>代表者のお名前<input name="household"></label><button>この内容で送る</button></form></main>'));
      } else if (path === "/fixture/help/first") {
        response.end(html('<main><h1>手伝える時間帯を教えてください</h1><form method="post"><label>お名前<input name="helper_name"></label><label>時間帯<input name="helper_times"></label><button>申し込む</button></form></main>'));
      } else if (path === "/fixture/admin/space/first") {
        response.end(html(spaceOpen
          ? '<main><h1>実行委員と班長のページ</h1><a href="/fixture/space/first">入口のアドレス</a></main>'
          : '<main><h1>実行委員と班長のページ</h1><p>まだ開いていません。</p><form method="post" action="/fixture/admin/space/first/open"><label>合言葉<input name="passphrase"></label><button>開く</button></form></main>'));
      } else if (path === "/fixture/space/first") {
        if (spaceOpen) response.end(html('<main><h1>合言葉を入れてください</h1><form method="post" action="/fixture/space/first/enter"><label>合言葉<input name="passphrase" type="password"></label><button>ログインする</button></form><a href="/fixture/space/first/join/secret">招待の入口</a><a href="/fixture/space/first/person/secret">班長の入口</a></main>'));
        else { response.writeHead(403); response.end(html('<main><h1>まだ開いていません</h1><p>役員がまだ開いていません。</p></main>')); }
      } else if (path === "/fixture/admin/projects") {
        response.end(html('<h1>新しく準備を始める</h1><form method="post"><label>名前<input name="title"></label><button>始める</button></form>'));
      } else if (path === "/fixture/admin/projects/first") {
        response.end(html('<a href="/fixture/admin/projects/first/map">やること</a><a href="/fixture/admin/answers/first">出欠の返事を見る</a><a href="/fixture/admin/projects/first/committee">実行委員名簿</a><a href="/fixture/admin/inbox/item-one/pick">LINEから届いたものを資料にする</a><a href="/fixture/admin/inbox/city/job-one/pick">送ったものを資料にれる</a><a href="/fixture/admin/projects/first/draft/notice">雨の変更</a><a href="/fixture/admin/projects/second/map">別のやること</a><a href="/fixture/admin/inbox">届いたもの</a><a href="/fixture/admin/archive">記録</a><a href="/fixture/admin/logout">出る</a><a href="/fixture/admin/projects/first/delete">消す</a><a href="/other/admin/">別の区</a><a href="/fixture/space/first/join/secret">一人用の入口</a>'));
      } else if (path === "/fixture/admin/answers/meeting") {
        response.end(html(`<main><p${url.searchParams.get("view") === "read" ? ' class="small"' : ""}>架空の総会の返事</p><div style="height:1000px"></div><button>この返事を入れる</button><button>もう一件の答えを入れる</button><a href="?view=unanswered&amp;print=1">未回答の紙</a><a href="/fixture/admin/answers/meeting/answer-one/edit">返事を直す</a></main>`));
      } else if (/\/committee$|\/rota\//.test(path) || path.endsWith("/pick") || path === "/fixture/admin/projects/duty/draft/duty_roster") {
        response.end(html('<main><p>架空の追加画面</p><div style="height:1000px"></div><button>一つ目の操作</button><button>二つ目の操作</button><a href="/fixture/admin/rota/exemptions/record-one/withdraw">免除を取り消す</a></main>'));
      } else if (path === "/fixture/admin/answers/first") {
        response.end(html(`<main>${url.searchParams.get("view") === "hand" ? '<div style="height:1000px"></div><form method="post"><button>この返事を入れる</button></form>' : '<p>架空の返事の画面</p>'}<a href="?view=summary">集計</a><a href="?view=hand">手で入れる</a><a href="?view=list&amp;q=fixture-query-text">一覧</a><a href="?view=list&amp;q=another-query-text">同じ一覧</a><a href="?view=unanswered">まだ返事のない世帯</a></main>`));
      } else if (path === "/fixture/admin/projects/first/draft/notice") {
        response.end(html(`<main><p${url.searchParams.get("edit") === "1" ? ' class="small"' : ""}>架空の知らせ</p><a href="?edit=1">下書きを書く</a></main>`));
      } else if (path === "/fixture/admin/projects/first/map") {
        response.end(html('<main class="wide"><p class="small">undefined null [object NaN</p><button style="min-height:20px;height:20px;font-size:12px">小さい操作</button><button>主な操作</button><div style="height:900px"></div><a href="/fixture/admin/settings">自治会の設定</a></main><script nonce="fixture">console.error("secret must not appear");console.error("Failed to load resource: net::ERR_FAILED https://invalid.example/fictional-only");fetch("/fixture/admin/projects/first/title",{method:"POST"}).catch(()=>{});fetch("/fixture/admin/logout").catch(()=>{})</script>'));
      } else if (path === "/fixture/admin/inbox") {
        response.writeHead(500); response.end(html("読めませんでした"));
      } else if (path === "/fixture/admin/archive") {
        response.end(html('<main><div style="height:1000px"></div><button>終わったものを見る</button></main>'));
      } else response.end(html('<main><p>架空の画面</p><div class="sheet"><small style="font-size:10px">紙の文字</small></div><svg><text font-size="10">図の文字</text></svg><details><summary>説明を読む</summary><small style="font-size:10px">閉じた説明</small><button>閉じた操作</button></details></main>'));
    });
    try {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const creds = resolve(temp, "creds.txt");
      writeFileSync(creds, "名前: 架空の役員\nパスワード: fictional-only\n", "utf8");
      const options = { base: `http://127.0.0.1:${address.port}`, ward: "fixture", creds, out: temp, meetingProject: "meeting", dutyProject: "duty" };
      const result = await check(options);
      report(options, result.results, result.project, result.capped);
      assert.equal(result.project, "first");
      for (const width of widths) {
        for (const path of ["/admin/projects/duty/draft/duty_roster", "/admin/rota/duty/result", "/admin/rota/exemptions", "/admin/rota/history", "/admin/projects/first/committee", "/admin/projects/meeting/committee"]) {
          const row = result.results.find((row) => row.path === `/fixture${path}` && row.width === width);
          assert.ok(row, path);
          assert.equal(row.primaryChecked, false);
          assert.deepEqual(row.failures, []);
        }
        for (const view of ["", "hand", "list", "read", "send", "sent", "unanswered"]) {
          const row = result.results.find((row) => row.path === `/fixture/admin/answers/meeting${view ? `?view=${view}` : ""}` && row.width === width);
          assert.ok(row, view);
          assert.equal(row.primaryChecked, false);
          assert.ok(!row.failures.some((failure) => failure.item.startsWith("主なボタン")));
          if (view === "read") assert.ok(row.failures.some((failure) => failure.item === "文字が18px未満"));
        }
        assert.ok(result.results.some((row) => row.path === "/fixture/admin/answers/meeting?view=unanswered&print=1" && row.width === width));
        assert.ok(result.results.some((row) => row.path === "/fixture/admin/answers/meeting/answer-one/edit" && row.width === width));
        for (const view of ["hand", "list", "unanswered"]) {
          assert.ok(result.results.some((row) => row.path === `/fixture/admin/answers/first?view=${view}` && row.width === width));
        }
        assert.ok(result.results.some((row) => row.path.endsWith("/answers/first?view=hand") && row.width === width && row.failures.some((failure) => failure.item === "主なボタンが一画面目に見えない")));
        assert.ok(result.results.some((row) => row.path.endsWith("/draft/notice?edit=1") && row.width === width && row.failures.some((failure) => failure.item === "文字が18px未満")));
        for (const path of ["/fixture/answer/first", "/fixture/help/first", ...(spaceOpen ? ["/fixture/space/first"] : [])]) {
          const publicPage = result.results.find((row) => row.path === path && row.width === width);
          assert.ok(publicPage, path);
          assert.deepEqual(publicPage.failures, [], path);
        }
        const map = result.results.find((row) => row.path.endsWith("/first/map") && row.width === width);
        assert.ok(map);
        for (const item of ["横のはみ出し", "文字が18px未満", "押せるものの高さが48px未満", "主なボタンが二つ以上", "文字の表示の誤り", "JavaScriptの誤り（console.errorなど）"]) assert.ok(map.failures.some((failure) => failure.item === item), item);
        assert.ok(result.results.some((row) => row.path.endsWith("/archive") && row.width === width && row.failures.some((failure) => failure.item === "主なボタンが一画面目に見えない")));
        assert.ok(result.results.some((row) => row.path.endsWith("/inbox") && row.width === width && row.failures.some((failure) => failure.detail.includes("500"))));
        assert.ok(result.results.some((row) => row.path.endsWith("/settings") && row.width === width && !row.failures.length));
      }
      assert.equal(requests.filter((request) => request.startsWith("POST ")).length, 1);
      assert.equal(result.results.filter((row) => row.path === "/fixture/admin/space/first").length, widths.length);
      assert.equal(requests.some((request) => request === "GET /fixture/space/first"), spaceOpen);
      assert.equal(result.results.filter((row) => row.path === "/fixture/space/first").length, spaceOpen ? widths.length : 0);
      assert.equal(requests.filter((request) => request.startsWith("GET /fixture/admin/answers/first?view=list&")).length, widths.length);
      assert.ok(requests.includes("GET /fixture/app.js"));
      assert.ok(!requests.includes("GET /favicon.ico"));
      assert.ok(!requests.some((request) => /second|other|logout|delete|join|person|\/enter|\/title|\/withdraw/.test(request)));
      const markdown = readFileSync(resolve(temp, "report.md"), "utf8");
      assert.ok(markdown.includes("通った画面:"));
      assert.ok(markdown.includes("主なボタンの位置・数は未判定: /fixture/admin/rota/exemptions"));
      assert.ok(markdown.includes("/answers/first?view=hand") && markdown.includes("/draft/notice?edit=1"));
      assert.ok(!markdown.includes("fixture-query-text") && !markdown.includes("another-query-text"));
      assert.ok(markdown.includes("Failed to load resource: net::ERR_FAILED"));
      assert.ok(markdown.includes("console.error: [本文を伏せました]"));
      assert.ok(!markdown.includes("secret must not appear") && !markdown.includes("fictional-only"));
    } finally {
      await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
      assert.ok(resolve(temp).startsWith(resolve(tmpdir(), "check-screens-")));
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

if (process.argv.includes("--self-test")) await selfTest();
else await main();
