// 総会をHTTPで通す道具。本物のAIを使う実行はPMが行う。
// npm run walkthrough-meeting -- --base <URL> --ward <区のURL名> --creds <資格情報ファイル>
export interface MeetingOptions {
  base: string;
  ward: string;
  name: string;
  password: string;
}
export interface MeetingPorts {
  fetch: typeof fetch;
  record: (report: string) => void | Promise<void>;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

// fixturesには総会の議案が無いため、期間中に作った架空の文を使う。
export function meetingMaterial(now = new Date()) {
  const day = new Date(now.getTime() + 60 * 86400_000);
  const due = new Date(now.getTime() + 30 * 86400_000);
  const date = (d: Date) => `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  const decision = "清掃活動は年2回行うことに決めました";
  return {
    year: day.getUTCFullYear(), date: date(day), due: date(due), decision,
    agenda: `すべて架空の総会の資料です。\n日時：${date(day)}10時\n場所：架空の集会室\n答えの締切：${date(due)}\n議案：清掃活動の回数、遊具の更新。いずれもまだ決めていません。\n住民の皆さまに総会への出席、委任、欠席を答えていただきます。回答票は班長か役員に渡してください。Webではこの案内のQRか区のページから答えてください。`,
    minutes: `すべて架空の総会の記録です。\n${date(day)}10時、架空の集会室で総会を開きました。\n${decision}。\n遊具の更新は話し合いを続けます。採決の数、議長、署名する人は記録していません。`,
    announcement: "総会を開きます。出席、委任、欠席を教えてください。回答票は班長か役員に渡してください。Webではこの案内のQRか区のページから答えてください。",
  };
}

function decode(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_m: string, code: string) => String.fromCodePoint(code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function visible(html: string) {
  return decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, "");
}
function forms(html: string) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(form => {
    const action = decode(/\baction="([^"]*)"/i.exec(form[1] ?? "")?.[1] ?? "");
    const body = form[2] ?? "";
    const values = new URLSearchParams();
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs = input[1] ?? "";
      if (/\bdisabled(?:\s|=|$)/i.test(attrs) || /type="(?:file|submit)"/i.test(attrs)) continue;
      if (/type="(?:checkbox|radio)"/i.test(attrs) && !/\bchecked(?:\s|=|$)/i.test(attrs)) continue;
      const name = /\bname="([^"]+)"/.exec(attrs)?.[1];
      if (name) values.append(name, decode(/\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? ""));
    }
    for (const field of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = /\bname="([^"]+)"/.exec(field[1] ?? "")?.[1];
      if (name) values.append(name, decode(field[2] ?? ""));
    }
    for (const select of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = /\bname="([^"]+)"/.exec(select[1] ?? "")?.[1];
      const options = [...(select[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(o => /\bselected(?:\s|=|$)/.test(o[1] ?? "")) ?? options[0];
      if (name && selected) values.append(name, decode(/\bvalue="([^"]*)"/.exec(selected[1] ?? "")?.[1] ?? selected[2] ?? ""));
    }
    return { action, values, body };
  });
}
function readForm(html: string, suffix: string) {
  const form = forms(html).find(f => f.action.split("?")[0]?.endsWith(suffix));
  if (!form) throw new Error("必要な入力欄がありません: " + suffix);
  return form;
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

// 意味が変わらないと言い切れない言い換えも停止にする。資料に無い決定を通過にしない。
export function checkMeetingMinutes(text: string, source: ReturnType<typeof meetingMaterial>) {
  const compact = (s: string) => s.normalize("NFKC").replace(/[\s#*「」『』【】]/g, "");
  assert(compact(text).includes(compact(source.decision)), "議事録に送った決定がありません（言い換えはPMの確認が必要です）");
  assert(/遊具[^。\n]*(?:続け|継続|保留)/.test(text), "議事録で話し合いを続ける議案を確認できません");
  const sourceSentences = source.minutes.split(/[。\n]/).map(compact);
  const knownFacts = new Set([...sourceSentences, compact(source.date + "10時"), "架空の集会室"]);
  for (const sentence of text.split(/[。\n]/).map(compact).filter(Boolean)) {
    const fact = sentence.replace(/^(?:[-・]|\d+[.)、])/, "").replace(/^(?:日時|場所|開催日時|開催場所|議案|審議の内容|決まったこと|決定事項)[:：]/, "");
    if (/^(?:議事録|日時|場所|開催日時|開催場所|議案|審議の内容|決まったこと|決定事項)[:：]?$/.test(fact)) continue;
    assert(knownFacts.has(fact), "議事録に資料と照合できない記述があります（言い換えはPMの確認が必要です）");
  }
}

export async function runMeetingWalkthrough(options: MeetingOptions, ports: MeetingPorts) {
  const base = new URL(options.base);
  assert(["http:", "https:"].includes(base.protocol) && base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password, "--baseには資格情報や区のパスを含まないURLを指定してください");
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.ward) && options.ward !== "demoku", "demokuでは通し確認を実行しません。確認用の区のURL名を指定してください");
  const root = `/${options.ward}`;
  const admin = root + "/admin";
  const projectTitle = "架空の総会 通し確認";
  const material = meetingMaterial();
  const cookies = new Map<string, { pair: string; path: string }>();
  const secrets = new Set([options.name, options.password]);
  const rows: string[] = [];
  let project = "";
  let printPath = "";
  let lastStatus = "HTTP応答なし";
  const sleep = ports.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const redact = (text: string) => {
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[伏せ字]");
    return text.replace(/[\r\n|]/g, " ");
  };
  const req = async (path: string, init: RequestInit = {}, resident = false) => {
    const url = new URL(path, base);
    assert(url.origin === base.origin && (url.pathname === root || url.pathname.startsWith(root + "/")), "指定の区の外には接続しません");
    const headers = new Headers(init.headers);
    headers.set("origin", base.origin);
    if (!resident) {
      const applicable = [...cookies.values()].filter(c => url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"));
      if (applicable.length) headers.set("cookie", applicable.map(c => c.pair).join("; "));
    }
    const res = await ports.fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    lastStatus = "HTTP " + res.status;
    if (!resident) for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0] ?? "";
      const name = pair.split("=", 1)[0] ?? "";
      secrets.add(pair); secrets.add(pair.slice(name.length + 1));
      cookies.set(name, { pair, path: /;\s*path=([^;]+)/i.exec(line)?.[1] ?? admin });
    }
    return res;
  };
  const post = (path: string, values: URLSearchParams | Record<string, string>, resident = false) => req(path, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values),
  }, resident);
  const get = async (path: string, resident = false) => {
    const res = await req(path, {}, resident);
    assert(res.ok, "画面を開けません");
    return res.text();
  };
  const redirected = (res: Response, message: string) => {
    const location = res.headers.get("location") ?? "";
    assert(res.status === 303 && location && !/[?&]error=/.test(location), message);
    return location;
  };
  const wait = async <T>(read: () => Promise<T | null>, label: string): Promise<T> => {
    const until = Date.now() + (ports.waitMs ?? 600_000);
    do {
      const result = await read();
      if (result !== null) return result;
      await sleep(3000);
    } while (Date.now() < until);
    throw new Error(label + "を待つ上限に達しました");
  };
  const upload = async (filename: string, text: string) => {
    const form = new FormData();
    form.set("project_id", project);
    form.append("part", new Blob([text], { type: "text/plain" }), filename);
    form.append("part_kind", "file");
    const sent = await req(admin + "/intake", { method: "POST", headers: { accept: "application/json" }, body: form });
    const result = await sent.json() as { ok?: boolean; jobId?: string };
    assert(sent.ok && result.ok && result.jobId, "架空の資料を受け付けられません");
    await wait(async () => {
      const html = await get(`${admin}/intake/received?project=${project}`);
      const section = [...html.matchAll(/<li\b[^>]*class="panel"[^>]*>([\s\S]*?)<\/li>/gi)].find(s => visible(s[1] ?? "").includes(filename));
      assert(section, "送った資料の読み取りの進み具合がありません");
      const status = visible(section[1] ?? "");
      assert(!/読めませんでした|読み取りが遅れています|繋げられませんでした|止まりました/.test(status), "資料の読み取り・反映が止まりました");
      return status.includes("行事に入れました") ? true : null;
    }, "資料の読み取り・反映");
  };
  const draft = async (kind: string) => {
    const path = `${admin}/projects/${project}/draft/${kind}`;
    redirected(await post(path + "/start", kind === "report" ? {
      instruction: "今年の会議の記録にある文を、そのまま使って議事録にしてください。見出し以外の文や決定を足さず、採決や議長など記録していないことを補わないでください。",
    } : {}), "AIに下書きを頼めません");
    return wait(async () => {
      const html = await get(path);
      const status = /data-ai-status="([^"]+)"/.exec(html)?.[1];
      assert(status !== "attention" && status !== "failed", "AIの下書きが止まりました");
      const form = readForm(html, `/draft/${kind}/save`);
      if (status !== "done") return null;
      assert(form.values.get("text")?.trim(), "AIが完了しましたが下書きが空です");
      return form;
    }, "AIの下書き");
  };
  const counts = (html: string) => {
    for (const [label, count] of [["答えた世帯", 5], ["出席", 2], ["委任", 2], ["欠席", 1]] as const) {
      // 名簿がある区では、答えた世帯の数の下は「○世帯のうち」と出る。
      const shown = label === "答えた世帯" ? "(?:答えた世帯|答えた世帯・名簿はまだありません|[0-9]+世帯のうち)" : label;
      assert(new RegExp(`<b>${count}<small>世帯</small></b><span>${shown}</span>`).test(html), label + "の数が答えと合いません");
    }
  };
  const stages: [string, () => Promise<string>][] = [
    ["1 総会を開く", async () => {
      const login = await post(admin + "/login", { name: options.name, password: options.password });
      redirected(login, "役員画面に入れません");
      assert(cookies.has("device"), "役員画面に入るための応答がありません");
      await get(admin + "/");
      const location = redirected(await post(admin + "/projects", { kind: "general_meeting", year: String(material.year) }), "総会を開けません");
      project = /\/projects\/([^/]+)\/map$/.exec(location)?.[1] ?? "";
      assert(project, "開いた総会を見つけられません");
      redirected(await post(`${admin}/projects/${project}/title`, { title: projectTitle }), "総会の題を保存できません");
      await get(location);
      return "種類を総会にして新しく開きました。資料・名前・答えはすべて架空です。";
    }],
    ["2 議案の資料を送る", async () => {
      await upload(`架空の総会_議案_${project}.txt`, material.agenda);
      return "架空の議案の文を送り、読み取りと反映が終わりました。";
    }],
    ["3 招集を頼んで配る", async () => {
      const form = await draft("announcement");
      assert(form.values.get("title") === "総会の招集", "AIの下書きの題が総会の招集ではありません");
      assert(form.values.get("scope") === "public", "招集が住民向けではありません");
      const body = [...form.values].filter(([key]) => key === "text" || key.startsWith("item_")).map(([, value]) => value).join("\n");
      assert(/総会/.test(body) && /出席/.test(body) && /委任/.test(body) && /欠席/.test(body), "招集に総会の出欠の案内がありません");
      assert(!/派生|差分|冪等|セッション|包み|状態|参考|版|札|列|縁|参加する人数|手伝いの時間帯/.test(body), "招集に住民向けではない言葉があります");
      for (const expected of [material.date, "架空の集会室", "清掃活動", "遊具"]) assert(visible(body).includes(expected), "招集に資料の日時・場所・議案がありません");
      const publishPage = await get(`${admin}/publish/${project}`);
      const section = [...publishPage.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)].find(s => /<h2>[^<]*総会の招集<\/h2>/.test(s[1] ?? ""));
      assert(section, "配る画面に総会の招集がありません");
      const first = readForm(section[1] ?? "", `/publish/${project}/confirm`);
      assert(first.values.get("documentId") && first.values.get("versionNo"), "招集と紙を結び付けられません");
      printPath = `${admin}/print/${project}/${first.values.get("documentId")}/${first.values.get("versionNo")}`;
      first.values.set("lineDelivery", "skip");
      const confirm = await post(first.action, first.values);
      assert(confirm.ok, "配る内容を確認できません");
      const html = await confirm.text();
      assert(html.includes("今回は公式LINEに送りません"), "LINEを送らない選択を確認できません");
      const final = readForm(html, `/publish/${project}/send`);
      assert(final.values.get("lineDelivery") === "skip", "LINE送信を止められません");
      redirected(await post(final.action, final.values), "招集を配れません");
      const page = await get(`${root}/p/${project}`, true);
      // 行事以外は、種類に合わせた題を見出しにする。
      assert(page.includes(`<h1>${projectTitle} 総会の招集</h1>`), "公開のページに総会の見出しがありません");
      assert(!page.includes("答えがないときは、欠席として数えます"), "総会の公開のページに行事の文があります");
      assert(/<title>[^<]*総会の招集/.test(page), "公開のページの題が総会の招集ではありません");
      const article = [...page.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].find(a => /<h2>総会の招集<\/h2>/.test(a[1] ?? ""))?.[1];
      assert(article && visible(article).includes(visible(form.values.get("text") ?? "")), "公開のページに招集の本文がありません");
      return "AIの招集の題、住民向けの文、日時・場所・議案を確認して配りました。公式LINEは送信していません。";
    }],
    ["4 Webで答える", async () => {
      const page = await get(`${root}/p/${project}`, true);
      const path = `${root}/answer/${project}`;
      assert(page.includes(path), "公開のページに答える入口がありません");
      const answers = [["架空出席一郎", "attend", ""], ["架空委任二郎", "proxy", "架空代理花子"], ["架空委任三郎", "proxy", ""], ["架空欠席四郎", "absent", ""]];
      for (const [household, status, proxy] of answers) {
        const answerPage = await get(path, true);
        const form = readForm(answerPage, path);
        // 班の名前は区ごとに違うので、答える画面の選びから取る。
        const district = /name="district"[^>]*value="([^"]+)"/.exec(answerPage)?.[1] ?? "";
        form.values.set("household", household!); form.values.set("district", district);
        form.values.set("meeting_status", status!); form.values.set("proxy_name", proxy!);
        const res = await post(form.action, form.values, true);
        assert(res.ok, "Webの答えを受け付けられません");
        const receipt = visible(await res.text());
        assert(receipt.includes(household!), "答えを受け付けた画面に代表者のお名前がありません");
        if (status === "proxy") assert(receipt.includes("委任する相手：" + (proxy || "空欄")), "委任する相手が答えと違います");
      }
      return "役員の入る情報を送らず、出席、名前ありの委任、空欄の委任、欠席を受け付けました。";
    }],
    ["5 回答票の紙を開く", async () => {
      const html = await get(printPath + "/answer");
      assert(/@page\s*\{[^}]*size:\s*A4/i.test(html), "回答票の紙がA4ではありません");
      const sheets = [...html.matchAll(/<section\b[^>]*class="[^"]*\bsheet\b[^"]*"[^>]*>([\s\S]*?)<\/section>/gi)].map(m => m[1]).join("\n");
      const text = visible(sheets);
      assert(sheets && /委任状/.test(text), "回答票に委任状を兼ねる文がありません");
      for (const label of ["□出席", "□委任", "□欠席", "委任する相手"]) assert(text.includes(label), "回答票に出欠や委任する相手の欄がありません");
      assert(!/人数|子ども|69歳|70歳|adults_count|children_count|seniors_count/.test(sheets), "総会の回答票に人数の欄があります");
      return "A4の印刷用HTMLの刷る範囲に、出欠・委任する相手・委任状の文があり、人数の欄がありません。印刷と見た目は未確認です。";
    }],
    ["6 電話の答えを入れて数える", async () => {
      const path = `${admin}/answers/${project}`;
      const handPage = await get(path + "?view=hand");
      const form = readForm(handPage, path + "/phone");
      const district = /name="district"[^>]*value="([^"]+)"/.exec(handPage)?.[1] ?? "";
      form.values.set("household", "架空電話五郎"); form.values.set("district", district);
      form.values.set("meeting_status", "attend"); form.values.set("proxy_name", "");
      redirected(await post(form.action, form.values), "電話の答えを入れられません");
      counts(await get(path));
      return "電話の出席を1件追加。答えた5世帯、出席2世帯、委任2世帯、欠席1世帯を画面で確認しました。";
    }],
    ["7 議事録を頼む", async () => {
      await upload(`架空の総会_記録_${project}.txt`, material.minutes);
      const form = await draft("report");
      assert(form.values.get("title") === "議事録", "AIの下書きの題が議事録ではありません");
      assert(form.values.get("scope") === "staff", "議事録が役員だけの下書きではありません");
      checkMeetingMinutes([...form.values].filter(([key]) => key === "text" || key.startsWith("item_")).map(([, value]) => value).join("\n"), material);
      return "送った決定1件と話し合いを続ける議案を照合し、議事録の記述が資料と一致することを確認しました。";
    }],
    ["8 閉じて記録を読む", async () => {
      const path = `${admin}/close/${project}`;
      const form = readForm(await get(path), path + "/finalize");
      // 議事録は役員の下書きとして保存済み。住民には架空の開催報告だけを出す。
      form.values.delete("body");
      form.values.append("body", "架空の総会を開きました。");
      form.values.append("body", material.minutes);
      redirected(await post(form.action, form.values), "総会を閉じられません");
      assert((await get(path)).includes("もう一度開く"), "総会を閉じたことを確認できません");
      const archive = await get(`${admin}/archive/${project}`);
      counts(archive);
      assert(!/(?:^|\D)0人/.test(visible(archive)), "総会の記録に0人と出ています");
      return "閉じた記録に出席2世帯、委任2世帯、欠席1世帯があり、0人とは出ません。";
    }],
  ];
  let stopped = false;
  for (const [stage, run] of stages) {
    const start = Date.now();
    let result = "停止";
    let detail = "前の段が停止したため、実行していません";
    if (!stopped) try {
      detail = await run(); result = "通過";
    } catch (error) {
      // 応答本文・Cookie・URL・資格情報ファイルの内容を証拠や標準出力へ流さない。
      detail = (error instanceof Error ? error.message : "処理に失敗しました") + "（" + lastStatus + "）";
      stopped = true;
    }
    rows.push(`| ${stage} | ${result} | ${redact(detail)} | ${Math.round((Date.now() - start) / 1000)} |`);
    await ports.record([
      "# 総会の通し確認", "", `- 実行日時: ${new Date().toISOString()}`, `- 接続先: ${base.origin}`, `- 区: ${options.ward}`,
      `- 総会: ${project || "まだ開いていません"}`, "- 資料と答え: すべて架空", "- 公式LINE: 実送信なし", "- 資格情報: 値は記録しません",
      "- この記録はHTTPとHTMLの確認です。本物のAI・staging・紙の見え方の確認は、実行環境に応じてPMが別に判断します。", "",
      "| 段 | 結果 | 確認したこと | 秒 |", "|---|---|---|---:|", ...rows, "",
    ].join("\n"));
    ports.log(`${stage}: ${result}${result === "停止" ? " " + redact(detail) : ""}`);
  }
  return { passed: !stopped, project };
}

async function main() {
  const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const args = process.argv.slice(2);
  const arg = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const base = arg("--base"); const ward = arg("--ward"); const creds = arg("--creds");
  if (!base || !ward || !creds) {
    console.error("使い方: npm run walkthrough-meeting -- --base <URL> --ward <区のURL名> --creds <資格情報ファイル>");
    process.exitCode = 2; return;
  }
  if (ward === "demoku") {
    console.error("demokuでは通し確認を実行しません。確認用の区を指定してください。");
    process.exitCode = 2; return;
  }
  const text = readFileSync(resolve(creds), "utf8");
  const name = /^(?:名前|氏名)\s*[:：]\s*(.+)$/m.exec(text)?.[1]?.trim();
  const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(text)?.[1]?.trim();
  assert(name && password, "資格情報は「名前:」「パスワード:」形式で指定してください");
  const evidence = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/EVIDENCE/walkthrough-meeting-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md");
  const result = await runMeetingWalkthrough({ base, ward, name, password }, {
    fetch, log: line => console.log(line), record: report => { mkdirSync(dirname(evidence), { recursive: true }); writeFileSync(evidence, report, "utf8"); },
  });
  console.log("記録: " + evidence);
  if (!result.passed) process.exitCode = 1;
}

// 試験からは副作用なしで読み込む。CLIだけが資格情報のファイルと証拠を扱う。
if (typeof process !== "undefined" && process.argv?.[1]) {
  const { pathToFileURL } = await import("node:url");
  if (pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => {
    console.error("準備: 停止。引数、資格情報ファイル、証拠の保存先を確認してください。値は表示しません。");
    process.exitCode = 1;
  });
}
