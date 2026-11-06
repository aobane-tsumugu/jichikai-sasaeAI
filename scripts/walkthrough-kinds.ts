// U51。PMが架空の区へ流すHTTPの通し確認。引数はwalkthrough-meetingと同じ。
import type { MeetingOptions, MeetingPorts } from "./walkthrough-meeting.ts";
import { kindsMaterial } from "../test/fixtures/kinds.ts";

class Stop extends Error {}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Stop(message);
}
function decode(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_m: string, code: string) => String.fromCodePoint(code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const compact = (text: string) => text.normalize("NFKC").replace(/[\s#*「」『』【】]/g, "");
const visible = (html: string) => decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " "));
const attr = (attrs: string, name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1] ?? "");
function forms(html: string) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(match => {
    const body = match[2] ?? "";
    const values = new URLSearchParams();
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs = input[1] ?? "";
      if (/\bdisabled(?:\s|=|$)/i.test(attrs) || /type="(?:file|submit)"/i.test(attrs)) continue;
      if (/type="(?:checkbox|radio)"/i.test(attrs) && !/\bchecked(?:\s|=|$)/i.test(attrs)) continue;
      if (attr(attrs, "name")) values.append(attr(attrs, "name"), attr(attrs, "value"));
    }
    for (const field of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      if (attr(field[1] ?? "", "name")) values.append(attr(field[1] ?? "", "name"), decode(field[2] ?? ""));
    }
    for (const select of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const options = [...(select[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(o => /\bselected(?:\s|=|$)/.test(o[1] ?? "")) ?? options[0];
      if (selected) values.append(attr(select[1] ?? "", "name"), attr(selected[1] ?? "", "value"));
    }
    return { action: attr(match[1] ?? "", "action"), values, body };
  });
}
function readForm(html: string, suffix: string) {
  const form = forms(html).find(f => f.action.split("?")[0]?.endsWith(suffix));
  assert(form, "必要な入力欄を確認できません");
  return form;
}
type Form = ReturnType<typeof readForm>;
const draftText = (form: Form) => [...form.values].filter(([key]) => key === "text" || key.startsWith("item_")).map(([, value]) => value).filter(Boolean).join("\n");

// 資料に無い決定を、特定の禁止語だけで見落とさない。言い換えもPMの確認へ回す。
export function checkKindsFacts(text: string, allowed: string[], required: string[], strict = false) {
  // AI は語尾を整えるので、語尾を除いた形で探す。
  const stem = (fact: string) => compact(fact).replace(/(?:ことに決めました|ことにします|ます|ました|。)+$/, "");
  // 未決は言い回しが変わるので、話題の語（「は」の前）があれば通す。決定は語尾を除いた全文を探す。
  for (const fact of required) {
    const key = /決め/.test(fact) ? stem(fact) : stem(fact).split("は")[0]!;
    assert(compact(text).includes(key), `送った決定や未決が下書きにありません（言い換えはPMの確認が必要です）: ${key.slice(0, 30)}`);
  }
  const known = new Set(allowed.flatMap(s => s.split(/[。\n]/)).map(compact));
  const words = allowed.flatMap(s => s.match(/[一-龠ァ-ヶー]{2,}/g) ?? []);
  // 句点の無い短い行は見出しや項目として扱い、文だけを照合する。
  const body = text.split("\n").filter((line) => !line.trim().startsWith("#") && (line.includes("。") || line.trim().length > 20)).join("\n");
  for (const sentence of body.split(/[。\n]/).map(compact).filter(Boolean)) {
    const fact = sentence.replace(/^(?:[-・]|\d+[.)、])/, "").replace(/^(?:決めたこと|決定事項|前回の決定|未決|保留|議題|日時|場所)[:：]/, "");
    if (/^(?:議事録|議題の資料|議案の資料|決めたこと|前回の決定|決定事項|未決|保留|決まらなかったこと・残っている質問)$/.test(fact)) continue;
    // AI は文を整えるので全文の一致は求めない。決定を述べる文は送った決定を含む事、他の文は資料の言葉を含む事を見る。
    if (strict) { assert(known.has(fact), "資料と照合できない文があります（送っていない決定や言い換えはPMの確認が必要です）"); continue; }
    const deciding = /決め|決定|可決|承認|採用/.test(fact) && !/まだ決め|決めていない|決まっていない|決まらなかった/.test(fact);
    assert(deciding ? [...known].some((entry) => entry && fact.includes(entry)) : words.some((word) => fact.includes(word)),
      `資料と照合できない文があります（送っていない決定や言い換えはPMの確認が必要です）: ${fact.slice(0, 40)}`);
  }
}

// 閉じる画面の決めたことは、AI が語尾を整えた短い文で入る。語尾の違いだけを許し、別の決定は通さない。
export function checkClosingDecisions(text: string, decision: string) {
  const want = compact(decision);
  const lines = text.split("\n").map(compact).filter(Boolean);
  assert(lines.some((line) => want.includes(line) || line.includes(want)), "送った決定が閉じる画面にありません");
  for (const line of lines) assert(want.includes(line) || line.includes(want), "閉じる画面に送っていない決定があります");
}

export function checkKindsDecision(text: string, decision: string) {
  // 画面が末尾に添える日付だけを外す。曜日の括弧と、決定文に含まれる括弧を区別する。
  const fact = text.replace(/（\d{1,2}月\d{1,2}日（[日月火水木金土]））\s*$/, "");
  checkKindsFacts(fact, [decision], [decision], true);
}

export async function runKindsWalkthrough(options: MeetingOptions, ports: MeetingPorts) {
  const base = new URL(options.base);
  assert(["http:", "https:"].includes(base.protocol) && base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password, "--baseには資格情報や区のパスを含まないURLを指定してください");
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.ward) && options.ward !== "demoku", "demokuでは通し確認を実行しません。確認用の区のURL名を指定してください");
  const root = `/${options.ward}`, admin = root + "/admin";
  const source = kindsMaterial();
  const projects: Record<string, string> = {};
  const cookies = { officer: new Map<string, { pair: string; path: string }>(), member: new Map<string, { pair: string; path: string }>() };
  const secrets = new Set([options.name, options.password]);
  const rows: string[] = [];
  let lastStatus = "HTTP応答なし";
  const sleep = ports.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const scrub = (value: string) => {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[伏せ字]");
    return value;
  };
  const redact = (value: string) => scrub(value).replace(/[\r\n|]/g, " ");
  type Audience = "officer" | "member" | "public";
  const req = async (path: string, init: RequestInit = {}, audience: Audience = "officer") => {
    const url = new URL(path, base);
    assert(url.origin === base.origin && (url.pathname === root || url.pathname.startsWith(root + "/")), "指定の区の外には接続しません");
    const headers = new Headers(init.headers);
    headers.set("origin", base.origin);
    headers.delete("cookie");
    if (audience !== "public") {
      const applicable = [...cookies[audience].values()].filter(c => url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"));
      if (applicable.length) headers.set("cookie", applicable.map(c => c.pair).join("; "));
    }
    lastStatus = "HTTP応答なし";
    const res = await ports.fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    lastStatus = "HTTP " + res.status;
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0] ?? "";
      const name = pair.split("=", 1)[0] ?? "";
      secrets.add(pair); secrets.add(pair.slice(name.length + 1));
      if (audience !== "public") cookies[audience].set(name, { pair, path: /;\s*path=([^;]+)/i.exec(line)?.[1] ?? admin });
    }
    return res;
  };
  const post = (path: string, values: URLSearchParams | Record<string, string>, audience: Audience = "officer") => req(path, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values),
  }, audience);
  const get = async (path: string, audience: Audience = "officer") => {
    const res = await req(path, {}, audience);
    assert(res.ok, "画面を開けません");
    return res.text();
  };
  const redirected = (res: Response, message: string) => {
    const location = res.headers.get("location") ?? "";
    assert(res.status === 303 && location && !/[?&]error=/.test(location), message);
    return location;
  };
  const wait = async <T>(read: () => Promise<T | null>): Promise<T> => {
    const until = Date.now() + (ports.waitMs ?? 600_000);
    do {
      const result = await read();
      if (result !== null) return result;
      await sleep(3000);
    } while (Date.now() < until);
    throw new Stop("AIの読み取り・下書きを待つ上限に達しました");
  };
  const open = async (key: string, kind: string, year: number, title: string, eventDay = "") => {
    const location = redirected(await post(admin + "/projects", { kind, year: String(year), title, eventDay }), "仕事を開けません");
    const id = /\/projects\/([^/]+)\/map$/.exec(location)?.[1];
    assert(id, "開いた仕事を見つけられません");
    projects[key] = id;
    await get(location);
    return id;
  };
  const upload = async (id: string, label: string, text: string) => {
    const filename = `架空の${label}_${id}.txt`;
    const form = new FormData();
    form.set("project_id", id); form.append("part", new Blob([text], { type: "text/plain" }), filename); form.append("part_kind", "file");
    const res = await req(admin + "/intake", { method: "POST", headers: { accept: "application/json" }, body: form });
    const result = await res.json() as { ok?: boolean; jobId?: string };
    assert(res.ok && result.ok && result.jobId, "架空の資料を受け付けられません");
    await wait(async () => {
      const html = await get(`${admin}/intake/received?project=${id}`);
      const section = [...html.matchAll(/<li\b[^>]*class="panel"[^>]*>([\s\S]*?)<\/li>/gi)].find(s => visible(s[1] ?? "").includes(filename));
      assert(section, "送った資料の読み取りの進み具合がありません");
      const status = visible(section[1] ?? "");
      assert(!/読めませんでした|読み取りが遅れています|繋げられませんでした|止まりました/.test(status), "資料の読み取り・反映が止まりました");
      return status.includes("行事に入れました") ? true : null;
    });
  };
  const draft = async (id: string, kind: string) => {
    const path = `${admin}/projects/${id}/draft/${kind}`;
    redirected(await post(path + "/start", { instruction: "送った資料と付記の記録の文をそのまま使い、決定と未決を分けてください。見出し以外の文や決定を足さないでください。" }), "AIに下書きを頼めません");
    return wait(async () => {
      const html = await get(path);
      const status = /data-ai-status="([^"]+)"/.exec(html)?.[1];
      assert(status !== "attention" && status !== "failed", "AIの下書きが止まりました");
      if (status !== "done") return null;
      const form = readForm(html, `/draft/${kind}/save`);
      assert(form.values.get("text")?.trim(), "AIが完了しましたが下書きが空です");
      assert(form.values.get("scope") === "staff", "役員用の下書きが公開や実行委員向けになっています");
      return { form, html };
    });
  };
  const close = async (id: string, staff: string, decisions?: string) => {
    const path = `${admin}/close/${id}`;
    const form = readForm(await get(path), path + "/finalize");
    form.values.delete("body"); form.values.append("body", ""); form.values.append("body", staff);
    if (decisions !== undefined) form.values.set("decisions", decisions);
    redirected(await post(form.action, form.values), "閉じて記録に残せません");
    assert((await get(path)).includes("もう一度開く"), "閉じたことを確認できません");
    await get(`${admin}/archive/${id}`);
  };
  const setRoster = async (names: string[], district: string) => {
    const form = new FormData();
    const cell = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const csv = [["代表者のお名前", "班"], ...names.map(name => [name, district])].map(row => row.map(cell).join(",")).join("\n");
    form.append("part", new Blob([csv], { type: "text/csv" }), "架空の名簿.csv");
    const res = await req(admin + "/answers/roster", { method: "POST", headers: { accept: "application/json" }, body: form });
    const result = await res.json() as { ok?: boolean };
    assert(res.ok && result.ok, "架空の名簿を入れられません");
  };
  const noReason = (html: string) => assert(![decode(html), visible(html)].some(text => compact(text).includes(compact(source.reason))), "免除の理由が公開・実行委員向けのページに出ています");
  const stages: [string, () => Promise<string>][] = [
    ["1 役員会を二回開く", async () => {
      redirected(await post(admin + "/login", { name: options.name, password: options.password }), "役員画面に入れません");
      assert(cookies.officer.has("device"), "役員画面に入るための応答がありません");
      // 区に前の試行の会議が残っていても、今回の二回が一番新しくなるように、試行ごとに先の日付を使う。
      const runDay = Math.floor((Date.now() - Date.UTC(2026, 10, 1)) / 300_000) * 2;
      const dayOf = (offset: number) => new Date(Date.UTC(2030, 0, 1) + (runDay + offset) * 86_400_000).toISOString().slice(0, 10);
      const today = dayOf(0), tomorrow = dayOf(1);
      const first = await open("board1", "board_meeting", source.year, "役員会1回目（架空）", today);
      await upload(first, "役員会の議題", source.agenda);
      await upload(first, "役員会の記録", source.minutes);
      const minutes = await draft(first, "report");
      checkKindsFacts(draftText(minutes.form), [source.minutes, source.agenda, `${source.year}年1月10日`, "架空の集会室"], [source.decision, source.pending]);
      // AIが拾った決定を人が閉じる画面から残す。住民への報告は空欄にする。
      const closing = readForm(await get(`${admin}/close/${first}`), `/close/${first}/finalize`);
      checkClosingDecisions(closing.values.get("decisions") ?? "", source.decision);
      await close(first, minutes.form.values.get("text") ?? "", source.decision);
      const second = await open("board2", "board_meeting", source.year, "役員会2回目（架空）", tomorrow);
      const agenda = await draft(second, "procedure");
      assert(visible(agenda.html).includes("前回の役員会"), "議題の下書きに前回の役員会の資料がありません");
      checkKindsFacts(draftText(agenda.form), [source.minutes, source.agenda, source.decision, source.pending], [source.decision, source.pending]);
      // 未決が資料の別の場所にあるだけでも、質問へ引き継がれなければ通過にしない。
      const questions = /<h4>決まらなかったこと・残っている質問<\/h4>([\s\S]*?)(?=<h4>|<a\b)/.exec(agenda.html)?.[1] ?? "";
      assert(compact(visible(questions)).includes(compact(source.pending)), "前回の未決が残っている質問にありません");
      await upload(second, "役員会2回目の記録", source.nextMinutes);
      const next = await draft(second, "report");
      checkKindsFacts(draftText(next.form), [source.nextMinutes, `${source.year}年2月10日`, "架空の集会室"], [source.nextDecision]);
      const nextClose = readForm(await get(`${admin}/close/${second}`), `/close/${second}/finalize`);
      checkClosingDecisions(nextClose.values.get("decisions") ?? "", source.nextDecision);
      await close(second, next.form.values.get("text") ?? "", source.nextDecision);
      return "資料の受付、二回の議事録と閉じる操作、前回の決定と未決、送っていない決定がないことを確認しました。";
    }],
    ["2 当番を翌年へ引き継ぐ", async () => {
      const previous = await open("duty1", "duty", source.year - 1, source.dutyTitle);
      const handPage = await get(`${admin}/answers/${previous}?view=hand`);
      const district = attr(/<input\b[^>]*name="district"[^>]*value="[^"]+"[^>]*>/.exec(handPage)?.[0] ?? "", "value") ||
        [...handPage.matchAll(/<select\b[^>]*name="district"[^>]*>([\s\S]*?)<\/select>/g)].flatMap(s => [...(s[1] ?? "").matchAll(/<option\b([^>]*)>/g)]).map(o => attr(o[1] ?? "", "value")).find(Boolean);
      assert(district, "班の選びに班の名前がありません。PMが確認用の区に班を用意してください");
      await setRoster([source.names.retained, source.names.exempt, source.names.departed], district);
      await upload(previous, "当番の表", source.duty);
      // 表が今年の中身へ入ったことを、閉じる前に担当の入力欄で確認する。
      const oldDraft = await get(`${admin}/projects/${previous}/draft/duty_roster`);
      const oldNames = forms(oldDraft).filter(f => /\/draft\/duty-row\//.test(f.action)).map(f => f.values.get("assignee"));
      assert(oldNames.length === 3 && [source.names.retained, source.names.exempt, source.names.departed].every(name => oldNames.includes(name)), "去年の当番の表が担当に反映されていません");
      await close(previous, "すべて架空の当番の記録です。");
      const seedPath = `${admin}/archive/${previous}/seed`;
      const seed = readForm(await get(`${admin}/archive/${previous}?view=seed`), seedPath);
      seed.values.set("year", String(source.year)); seed.values.set("title", source.dutyTitle);
      const location = redirected(await post(seed.action, seed.values), "来年の当番を開けません");
      const current = new URL(location, base).searchParams.get("started");
      assert(current, "来年の当番を見つけられません"); projects.duty2 = current;
      await setRoster([source.names.retained, source.names.exempt, source.names.arrived], district);
      const exemptionPath = admin + "/rota/exemptions";
      const exemption = readForm(await get(exemptionPath), exemptionPath);
      const selected = [...exemption.body.matchAll(/<option\b([^>]*)>/g)].map(o => attr(o[1] ?? "", "value")).find(value => {
        try { const entry = JSON.parse(value) as { household?: string; district?: string }; return entry.household === source.names.exempt && entry.district === district; } catch { return false; }
      });
      assert(selected, "免除を記録する世帯の選びがありません");
      exemption.values.set("household", selected); exemption.values.set("reason", source.reason);
      exemption.values.set("starts_on", `${source.year}-01-01`); exemption.values.set("ends_on", `${source.year}-12-31`);
      redirected(await post(exemption.action, exemption.values), "免除を記録できません");
      assert((await get(exemptionPath)).includes(source.reason), "役員用の免除の記録がありません");
      const path = `${admin}/projects/${current}/draft/duty_roster`;
      redirected(await post(path + "/start", {}), "去年の表と今の名簿から当番の下書きを作れません");
      const html = await get(path);
      noReason(html);
      assert(visible(html).includes(source.names.arrived) && visible(html).includes(source.names.departed), "名簿に加わった世帯と今の名簿にない担当を確認できません");
      const duties = forms(html).filter(f => /\/draft\/duty-row\//.test(f.action));
      assert(duties.length === 3, "当番の下書きが3件ではありません");
      for (const [index, row] of duties.entries()) {
        assert(row.values.get("slot") === source.slots[index], "去年の当番の順番が変わっています");
        assert(row.values.get("assignee") === (index === 0 ? source.names.retained : ""), "免除や転出の世帯が担当に残っています");
      }
      // 転入した世帯の場所を人が選ぶ。Workersは勝手に割り当てない。
      const vacant = duties[2]; assert(vacant, "転入した世帯を入れる欄がありません");
      vacant.values.set("assignee", source.names.arrived);
      redirected(await post(vacant.action, vacant.values), "転入した世帯の担当を保存できません");
      const save = readForm(await get(path), `/draft/duty_roster/save`);
      save.values.set("text", "架空の集積所の当番表です。");
      redirected(await post(save.action, save.values), "当番表を保存できません");
      // 今の配る確認画面の隠し項目を使い、実行委員向けだけに配る。
      const confirm = await get(`${admin}/publish/${current}/confirm?kind=duty_roster`);
      const send = readForm(confirm, `/publish/${current}/space`);
      redirected(await post(send.action, send.values), "当番表を実行委員向けに配れません");
      const passphrase = "架空の通し確認" + current;
      secrets.add(passphrase);
      assert((await post(`${admin}/space/${current}/open`, { passphrase })).ok, "実行委員のページを開けません");
      redirected(await post(`${root}/space/${current}/enter`, { passphrase }, "member"), "実行委員として入れません");
      const space = await get(`${root}/space/${current}`, "member");
      assert(space.includes("実行委員のページ") && space.includes(source.names.arrived) && space.includes(source.names.retained), "配った当番表が実行委員のページにありません");
      assert(!space.includes(source.names.exempt) && !space.includes(source.names.departed), "実行委員の当番表に免除や転出の世帯があります");
      noReason(space); noReason(await get(root + "/", "public"));
      const publicProject = await req(`${root}/p/${current}`, {}, "public");
      assert(publicProject.status === 404, "当番表が公開のページに出ています"); noReason(await publicProject.text());
      const paper = await get(`${admin}/print/${current}/${send.values.get("documentId")}/${send.values.get("versionNo")}/duty`);
      assert(paper.includes(source.names.arrived), "当番表の紙に転入した世帯の担当がありません"); noReason(paper);
      return "去年の表から翌年を開き、名簿の転入・転出と免除を反映。転入の担当を直して配り、公開・実行委員・紙に免除の理由が出ないことを確認しました。";
    }],
    ["3 市の依頼を配らずに閉じる", async () => {
      const id = await open("city", "city_request", source.year, "設備の状況の回答（架空）");
      await upload(id, "市の通知", source.city);
      const result = await draft(id, "procedure");
      assert(result.form.values.get("title") === "回答の資料", "市の依頼の下書きが回答の資料ではありません");
      const text = draftText(result.form);
      for (const fact of ["架空の地域担当窓口", `${source.year}年3月31日`, "照明の数", "交換の希望"]) assert(compact(text).includes(compact(fact)), "回答の資料に通知の提出先・期限・様式がありません");
      assert(!/参加してください|ご参加|出欠|手伝いの募集|皆さま|みなさま/.test(text), "市の回答の資料が住民向けの案内になっています");
      await close(id, "すべて架空の記録です。市へ回答するための資料を受け取りました。まだ提出していません。");
      assert((await req(`${root}/p/${id}`, {}, "public")).status === 404, "配っていない市の依頼が公開されています");
      return "通知の提出先・期限・様式が役員用の回答の資料にあり、住民向けの案内ではありません。配らず、住民への報告も空欄で閉じました。";
    }],
    ["4 総会に一年の決定を引き継ぐ", async () => {
      const id = await open("general", "general_meeting", source.year, "一年の議案（架空）");
      const html = await get(`${admin}/projects/${id}/draft/procedure`);
      const section = new RegExp(`<h3>${source.year}年の会議で決めたこと<\\/h3>([\\s\\S]*?)<\\/section>`).exec(html)?.[1] ?? "";
      const items = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<p>/g)].map(m => visible(m[1] ?? ""));
      assert(items.length >= 2, "総会の議案の資料に一年の決定がありません");
      // 既にある別の架空の会議は許すが、今回の会議は送った決定だけでなければ止める。
      for (const [key, decision] of [["board1", source.decision], ["board2", source.nextDecision]]) {
        const own = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].filter(m => m[1]?.includes(`/projects/${projects[key!]}/draft/report`));
        assert(own.length === 1, "今回の役員会の決定が増えているか、総会の資料から欠けています");
        const fact = visible((own[0]?.[1] ?? "").split("<p>")[0] ?? "");
        checkKindsDecision(fact, decision!);
      }
      const generated = await draft(id, "procedure");
      // 議案の下書きには行事の報告も入るので、語尾を除いた二つの決定があり、別の決定が足されていない事を見る。
      const generatedText = draftText(generated.form);
      const stems = [source.decision, source.nextDecision].map((decision) => decision.replace(/ことに決めました$/, ""));
      for (const stem of stems) assert(compact(generatedText).includes(compact(stem)), "総会の議案の下書きに一年の決定がありません");
      for (const line of generatedText.split(/[。\n]/).map(compact).filter((entry) => /決めました|決定しました|可決/.test(entry))) {
        assert(stems.some((stem) => line.includes(compact(stem))), `総会の議案の下書きに送っていない決定があります: ${line.slice(0, 40)}`);
      }
      return "総会の議案の下書きの資料とAIの下書きに、二回の役員会で送った一年の決定があり、今回の記録に決定が足されていないことを確認しました。";
    }],
  ];
  let stopped = false;
  for (const [stage, run] of stages) {
    const start = Date.now();
    let result = "停止", detail = "前の段が停止したため、実行していません";
    if (!stopped) try { detail = await run(); result = "通過"; }
    catch (error) {
      // 外部の例外、応答本文、URLを記録しない。資格情報を含む可能性があるため。
      detail = (error instanceof Stop ? error.message : "処理を続けられません。接続先と読み取りの進み具合をPMが確認してください") + `（${lastStatus}）`;
      stopped = true;
    }
    rows.push(`| ${stage} | ${result} | ${redact(detail)} | ${Math.round((Date.now() - start) / 1000)} |`);
    await ports.record(scrub([
      "# 行事と総会の外の通し確認", "", `- 実行日時: ${new Date().toISOString()}`, `- 接続先: ${base.origin}`, `- 区: ${options.ward}`,
      ...Object.entries(projects).map(([kind, id]) => `- 作った仕事（${kind}）: ${id}`),
      "- 資料・世帯・理由: すべて架空", "- 公式LINE: 実送信なし", "- 資格情報: 値は記録しません",
      "- HTTPとHTMLの確認です。本物のAI・staging・紙の見え方の確認は実行環境に応じてPMが判断します。", "",
      "| 段 | 結果 | 確認したこと | 秒 |", "|---|---|---|---:|", ...rows, "",
    ].join("\n")));
    ports.log(`${stage}: ${result}${result === "停止" ? " " + redact(detail) : ""}`);
  }
  return { passed: !stopped, projects };
}

async function main() {
  const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const args = process.argv.slice(2);
  const arg = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const base = arg("--base"), ward = arg("--ward"), creds = arg("--creds");
  if (!base || !ward || !creds || ward === "demoku") {
    console.error("使い方: npm run walkthrough-kinds -- --base <URL> --ward <架空の区のURL名> --creds <資格情報ファイル>。demokuでは実行しません。");
    process.exitCode = 2; return;
  }
  const text = readFileSync(resolve(creds), "utf8");
  const name = /^(?:名前|氏名)\s*[:：]\s*(.+)$/m.exec(text)?.[1]?.trim();
  const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(text)?.[1]?.trim();
  assert(name && password, "資格情報は「名前:」「パスワード:」形式で指定してください");
  const evidence = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/EVIDENCE/walkthrough-kinds-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md");
  const result = await runKindsWalkthrough({ base, ward, name, password }, {
    fetch, log: line => console.log(line), record: report => { mkdirSync(dirname(evidence), { recursive: true }); writeFileSync(evidence, report, "utf8"); },
  });
  console.log("記録: " + evidence);
  if (!result.passed) process.exitCode = 1;
}
if (typeof process !== "undefined" && process.argv?.[1]) {
  const { pathToFileURL } = await import("node:url");
  if (pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => {
    console.error("準備: 停止。引数、資格情報ファイル、証拠の保存先を確認してください。値は表示しません。");
    process.exitCode = 1;
  });
}
