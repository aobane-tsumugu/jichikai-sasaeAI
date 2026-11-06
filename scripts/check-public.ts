// 公開前の候補を探す読み取り専用の道具。検出値・本文・外部設定の中身は出力しない。
// npm run check:public -- --config /リポジトリ外/check.json
// 設定: { terms: { affiliation: [], municipality: [], participant: [], benefitCode: [] }, referenceFiles: [] }
// termsはPUBLIC_CHECK_TERMSのJSONでも渡せる。referenceFilesは管理文書のテキスト原本。
// 事前に公開対象の枝とタグを取得する。この道具自身は通信・履歴変更・公開をしない。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const groups = ["affiliation", "municipality", "participant", "benefitCode"] as const;
type Group = typeof groups[number];
type Terms = Partial<Record<Group, string[]>>;
type Place = { source: "tree" | "index" | "history" | "commit"; path?: string; commit?: string; blob?: string };
type Finding = Place & { kind: string; line: number };
type Config = { terms: Terms; referenceFiles: string[] };
const normalize = (text: string) => text.normalize("NFKC");
const compact = (text: string) => normalize(text).replace(/\s+/gu, "");
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const COPY_LENGTH = 80;

// 形が決まっている鍵と、認証用の項目に直接書かれた値を調べる。一般の長いIDを鍵と決めつけない。
const patterns: [string, RegExp][] = [
  ["credential", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g],
  ["credential", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g],
  ["private-key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ["email", /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi],
  ["benefit-code", /(?:特典|クーポン|coupon|promo|benefit|redeem)[_\s-]*(?:コード|code)\s*[:：=]\s*["']?[A-Za-z0-9][A-Za-z0-9_-]{3,}/gi],
];
const assignments = [
  /\b(?:[A-Z_]*(?:API_KEY|API_TOKEN|ACCESS_TOKEN|CHANNEL_SECRET|PASSWORD)|apiKey|apiToken|accessToken|channelSecret|password)["']?\s*[:=]\s*["']([^\s"'`$\{\}<>]{16,})["']/gi,
  /^\s*(?:export\s+)?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*([A-Za-z0-9_+/=-]{24,})\s*(?:#.*)?$/g,
];
const evidenceId = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64}|[UCR][0-9a-f]{32}|(?:sess|session|agent|vault|msg)_[A-Za-z0-9_-]{8,})\b|\b(?:ward|project|job|original|account|document|version|ticket|group|user)[_-]?id["']?\s*[:=]\s*["']?[^\s"'<>`,;|]{4,}/gi;
const fictionalEmail = (value: string) => /@(?:[^@]*\.)?(?:example\.(?:com|net|org)|invalid|test|example|localhost)$/i.test(value);
const placeholder = (value: string) => /^(?:fictional|fixture|test|fake|dummy|example|placeholder|not-real|replace|change.?me|your[-_]|x+$)/i.test(value) || /\$\{|process\.env|env\./.test(value);
function credentialAssignment(text: string): boolean {
  return assignments.some((pattern) => {
    pattern.lastIndex = 0;
    return [...text.matchAll(pattern)].some((match) => !placeholder(match[1]!));
  });
}

export class Inspector {
  findings: Finding[] = [];
  private readonly copies = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly terms: Terms;
  constructor(terms: Terms, references: string[]) {
    this.terms = terms;
    for (const reference of references) {
      const text = compact(reference);
      for (let i = 0; i + COPY_LENGTH <= text.length; i++) this.copies.add(text.slice(i, i + COPY_LENGTH));
    }
  }
  private add(place: Place, kind: string, line: number) {
    // 同じ行に同種の候補が複数あっても、本文を並べず一つの場所として返す。
    const safe = { ...place };
    if (safe.path && this.containsPrivateValue(safe.path)) safe.path = `[path:${digest(safe.path)}]`;
    const finding = { ...safe, kind, line };
    const key = JSON.stringify(finding);
    if (!this.seen.has(key)) { this.seen.add(key); this.findings.push(finding); }
  }
  private containsPrivateValue(text: string): boolean {
    if (/(?:password|token|secret|credential|api_key)\s*[:=]/i.test(text)) return true;
    if (Object.values(this.terms).some((values) => values.some((value) => normalize(text).toLowerCase().includes(normalize(value).toLowerCase())))) return true;
    if (credentialAssignment(text)) return true;
    return patterns.some(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(text); });
  }
  inspect(text: string, place: Place) {
    const evidence = place.path?.replaceAll("\\", "/").startsWith("docs/EVIDENCE/");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const [kind, pattern] of patterns) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          if (kind !== "email" || !fictionalEmail(match[0])) this.add(place, kind, i + 1);
        }
      }
      if (credentialAssignment(line)) this.add(place, "credential-assignment", i + 1);
      for (const group of groups) {
        if (this.terms[group]?.some((term) => normalize(line).toLowerCase().includes(normalize(term).toLowerCase()))) this.add(place, group, i + 1);
      }
      if (evidence) {
        if (/https?:\/\/[^\s<>"')]+/i.test(line)) this.add(place, "evidence-url", i + 1);
        evidenceId.lastIndex = 0;
        if (evidenceId.test(line)) this.add(place, "evidence-id", i + 1);
      }
    }
    if (this.copies.size) {
      const value = compact(text);
      for (let i = 0; i + COPY_LENGTH <= value.length; i++) {
        if (this.copies.has(value.slice(i, i + COPY_LENGTH))) { this.add(place, "management-copy", 0); break; }
      }
    }
  }
  path(path: string, place: Place) {
    this.inspect(path, place);
    if (/(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|admin-docs[^/]*)$/i.test(path) && !/\.(?:example|sample|template)$/i.test(path)) this.add(place, "private-file", 0);
  }
}

function git(root: string, args: string[], input?: string): Buffer {
  // 失敗時のGitの標準出力・標準エラーには本文が含まれ得るため、例外の中身を外へ出さない。
  try { return execFileSync("git", ["-C", root, ...args], { input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { throw new Error("Gitの読み取りに失敗しました（詳細と本文は出力しません）"); }
}
function outsideFile(root: string, file: string): string {
  const resolved = realpathSync(file);
  const rel = relative(root, resolved);
  if (!rel || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error("設定と参照文書はリポジトリの外へ置いてください");
  return resolved;
}
function readConfig(root: string, file?: string): Config {
  let raw: unknown = {};
  try { if (file) raw = JSON.parse(readFileSync(outsideFile(root, resolve(file)), "utf8")); }
  catch { throw new Error("外部設定を読めません。リポジトリ外のJSONを指定してください（内容は出力しません）"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("外部設定はJSONのオブジェクトにしてください");
  const value = raw as { terms?: unknown; referenceFiles?: unknown };
  let terms = value.terms ?? {};
  try { if (process.env.PUBLIC_CHECK_TERMS) terms = JSON.parse(process.env.PUBLIC_CHECK_TERMS); }
  catch { throw new Error("PUBLIC_CHECK_TERMSは照合語のJSONにしてください（値は出力しません）"); }
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) throw new Error("照合語は種類ごとのJSONの配列にしてください");
  const checked: Terms = {};
  for (const group of groups) {
    const words = (terms as Record<string, unknown>)[group];
    if (words === undefined) continue;
    if (!Array.isArray(words) || words.some((word) => typeof word !== "string" || !word.trim())) throw new Error("照合語に文字列以外か空欄があります（値は出力しません）");
    checked[group] = words.map((word: string) => word.trim());
  }
  const files = value.referenceFiles ?? [];
  if (!Array.isArray(files) || files.some((path) => typeof path !== "string" || !isAbsolute(path))) throw new Error("参照文書にはリポジトリ外の絶対パスの配列を指定してください");
  return { terms: checked, referenceFiles: files as string[] };
}
function textFrom(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
}

export function checkPublic(root: string, config: Config) {
  const references: string[] = [];
  const incomplete: string[] = [];
  for (const file of config.referenceFiles) {
    try {
      const text = textFrom(readFileSync(outsideFile(root, file)));
      if (text === null || compact(text).length < COPY_LENGTH) throw new Error();
      references.push(text);
    } catch { incomplete.push("参照文書をテキストとして読めません（外部パスと内容は非表示）"); }
  }
  for (const group of groups) if (config.terms[group] === undefined) incomplete.push(`照合語の未指定: ${group}`);
  if (!references.length) incomplete.push("管理文書の長文照合は未実施（外部のテキスト原本が必要）");
  const inspector = new Inspector(config.terms, references);
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "true";
  if (shallow) incomplete.push("浅い取得のためGit履歴に未取得の部分があります");
  const commits = git(root, ["rev-list", "--all"]).toString().trim().split("\n").filter(Boolean);
  const refs = git(root, ["for-each-ref", "--format=%(refname)"]).toString().trim().split("\n").filter(Boolean);
  const blobs = new Map<string, Place>();
  // 全親との差を読むので、mergeでだけ作られた内容と、後で消えたファイルも拾う。
  const raw = git(root, ["log", "--all", "--root", "-m", "--raw", "-z", "--no-abbrev", "--no-renames", "--format=%x00commit:%H%x00"]).toString().split("\0");
  let commit = "";
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i]!.trim();
    if (part.startsWith("commit:")) { commit = part.slice(7); continue; }
    const entry = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]$/.exec(part);
    if (!entry) continue;
    const path = raw[++i]!;
    const place: Place = { source: "history", path, commit, blob: entry[2]! };
    inspector.path(path, place);
    if (/^100|^120/.test(entry[1]!) && !/^0+$/.test(entry[2]!)) {
      const prior = blobs.get(entry[2]!);
      // 同じ本文が複数箇所にある場合でも、EVIDENCEの照合を落とさない。
      if (!prior || path.startsWith("docs/EVIDENCE/")) blobs.set(entry[2]!, place);
    }
  }
  // ステージにだけ残り、作業中のファイルからは消えた値も、次のcommitへ入れない。
  const staged = git(root, ["ls-files", "--stage", "-z"]).toString().split("\0").filter(Boolean);
  for (const row of staged) {
    const entry = /^(100\d{3}|120000) ([0-9a-f]+) \d\t([\s\S]+)$/.exec(row);
    if (!entry) continue;
    const place: Place = { source: "index", path: entry[3]!, blob: entry[2]! };
    inspector.path(entry[3]!, place);
    if (!blobs.has(entry[2]!)) blobs.set(entry[2]!, place);
  }
  let binaryHistory = 0;
  const objectIds = [...commits, ...blobs.keys()];
  const batch = git(root, ["cat-file", "--batch"], objectIds.join("\n") + "\n");
  let offset = 0;
  for (const id of objectIds) {
    const end = batch.indexOf(10, offset);
    const header = /^([0-9a-f]+) (blob|commit) (\d+)$/.exec(batch.subarray(offset, end).toString());
    if (!header || header[1] !== id) throw new Error("Gitオブジェクトの読み取りが完了しませんでした");
    const size = Number(header[3]);
    const bytes = batch.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size) throw new Error("Gitオブジェクトの読み取りが途中で止まりました");
    offset = end + 1 + size + 1;
    const text = textFrom(bytes);
    if (text === null) { binaryHistory++; continue; }
    inspector.inspect(text, header[2] === "commit" ? { source: "commit", commit: id } : blobs.get(id)!);
  }
  let treeFiles = 0;
  let binaryTree = 0;
  const paths = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean))];
  for (const path of paths) {
    const place: Place = { source: "tree", path };
    inspector.path(path, place);
    try {
      const full = resolve(root, path);
      const stat = lstatSync(full);
      const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : stat.isFile() ? readFileSync(full) : null;
      if (!bytes) { incomplete.push("作業ツリーに通常のファイルとして読めない項目があります"); continue; }
      treeFiles++;
      const text = textFrom(bytes);
      if (text === null) binaryTree++;
      else inspector.inspect(text, place);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete.push("作業ツリーの読み取りに失敗しました（詳細は非表示）");
    }
  }
  for (const ref of refs) inspector.path(ref, { source: "history", path: ref });
  const counts: Record<string, number> = {};
  for (const finding of inspector.findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  return {
    scope: { history: "local-all-refs", refs: refs.length, commits: commits.length, blobs: blobs.size, treeFiles, shallow, referenceDocuments: references.length },
    limits: { binaryTree, binaryHistory, note: "未取得の枝・タグ、到達不能なオブジェクト、Gitの除外設定にある未追跡ファイル、画像や圧縮文書の中身は対象外。同じblobは代表の場所を返します。長文照合は空白を除いた80文字以上の一致です。公開の可否はこの結果だけで決めません。" },
    incomplete: [...new Set(incomplete)], counts, findings: inspector.findings,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("npm run check:public -- [--config <リポジトリ外のJSON>]\n環境変数: PUBLIC_CHECK_CONFIG（設定パス）、PUBLIC_CHECK_TERMS（種類ごとの配列のJSON）\n設定: { terms: { affiliation: [], municipality: [], participant: [], benefitCode: [] }, referenceFiles: [外部テキストの絶対パス] }\n空配列は該当語なしを明示する指定です。全枝・タグを取得した作業ツリーで実行してください。値や本文を出さず、種類と場所だけJSONで出します。終了値: 0候補なし、1要確認の候補あり、2未確認項目あり／実行失敗。");
    return;
  }
  let configPath = process.env.PUBLIC_CHECK_CONFIG;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new Error("引数は--helpか--configだけを指定してください");
    configPath = args[1];
  }
  const root = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString().trim());
  const report = checkPublic(root, readConfig(root, configPath));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.incomplete.length ? 2 : report.findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch { console.error("公開前の検査を完了できませんでした。引数、外部設定、Gitの取得状態を確かめてください。値と詳細は出力しません。"); process.exitCode = 2; }
}
