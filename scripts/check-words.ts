// node scripts/check-words.ts [調べるsrcの場所]
// 静的な画面の文字の候補を読む。候補を表示するだけで、ファイルや終了コードは変えない。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(process.argv[2] ?? resolve(root, "src"));
const wording = readFileSync(resolve(root, "CLAUDE.md"), "utf8");
const terms = new Map<string, string>([
  ["プロジェクト", "名前（まとめた呼び名を作らない）"], ["空間", "実行委員と班長のページ"], ["原本", "元の資料"],
  ["受け箱", "届いたもの"], ["地図", "やること（会場の地図などは対象外）"],
  ["出した物", "知らせたもの"], ["出したもの", "知らせたもの"], ["参考の中身", "過去の資料の中身"],
  // 2026-11-07 の表で直した言い方。CLAUDE.md の「」の形に書けないものをここに置く。
  ["」と書かれています", "急ぎかもしれません（「明日」とあります）"], ["一年の行", "一年の予定"], ["外した行", "外した予定"],
  ["帯の濃さ", "紺が濃い予定ほど、送った資料や出欠の返事がたくさん入っています"], ["この仕組み", "SasaeAI"],
]);
for (const match of wording.matchAll(/「([^」]+)」は「([^」]+)」/g)) {
  for (const old of match[1]!.split("、")) terms.set(old, match[2]!);
}
const forbidden = /^- ([^。\n]+)は画面に出しません。/m.exec(wording)?.[1] ?? "";
for (const word of forbidden.split("、").filter(Boolean)) terms.set(word, "画面には出さない");
const segments = new Intl.Segmenter("ja", { granularity: "word" });
const attributes = new Set(["title", "alt", "placeholder", "aria-label", "label", "text"]);

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return files(child);
    return /\.tsx?$/.test(entry.name) && !/\.(?:test|d)\.tsx?$/.test(entry.name) && entry.name !== "testing.ts" ? [child] : [];
  }).sort();
}

function excluded(node: ts.Node, source: ts.SourceFile): boolean {
  const parent = node.parent;
  if (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return !attributes.has(current.name.getText(source));
    if (ts.isPropertyAssignment(current) && /(?:system|prompt|instruction)/i.test(current.name.getText(source))) return true;
    if (ts.isVariableDeclaration(current) && /(?:^sql$|system|prompt|css|styles)/i.test(current.name.getText(source))) return true;
    if (ts.isVariableDeclaration(current) && current.name.getText(source) === "common" && /[/\\]draft[/\\]packs[/\\]/.test(source.fileName)) return true;
    if (ts.isJsxElement(current) && current.openingElement.tagName.getText(source) === "style") return true;
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const callee = current.expression.getText(source);
      if (/(?:^|\.)(?:prepare|exec)$/.test(callee) || /^console\./.test(callee) || callee === "RegExp" || /\.messages\.create$/.test(callee)) return true;
      if (current.arguments?.[0] === node && /\.(?:get|getAll|has|delete|includes|startsWith|endsWith|replace|replaceAll)$/.test(callee)) return true;
    }
  }
  return false;
}

type Finding = { path: string; line: number; kind: string; word: string; next: string; text: string };
const findings: Finding[] = [];
function scan(source: ts.SourceFile, path: string, lineOffset = 0) {
  function visit(node: ts.Node) {
    // ブラウザ用JavaScriptも構文で読む。中のコメントや変数名を画面の文と取り違えない。
    if (ts.isNoSubstitutionTemplateLiteral(node) && ts.isTaggedTemplateExpression(node.parent)
      && node.parent.tag.getText(source) === "String.raw" && /^\s*\(function\b/.test(node.text)) {
      scan(ts.createSourceFile(path + ".js", node.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), path,
        lineOffset + source.getLineAndCharacterOfPosition(node.getStart(source)).line);
      return;
    }
    const isText = ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isText && !excluded(node, source)) {
      const text = node.text;
      // 変数に置かれたSQLも含めて除く。識別子・コメント・正規表現は構文上の文字列ではない。
      const sql = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|REPLACE|WHERE|JOIN|CASE)\b/i.test(text);
      if (!sql && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
        const line = lineOffset + source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const add = (kind: string, word: string, next: string) => findings.push({ path: relative(root, path).replaceAll("\\", "/"), line, kind, word, next, text: text.replace(/\s+/g, " ").trim().slice(0, 100) });
        const words = [...segments.segment(text)];
        for (const [old, next] of terms) {
          // 「案内」の「案」は下書きの意味ではない。
          const positions = old === "案" ? words.filter(word => word.segment === old) : [...text.matchAll(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
          for (const _ of positions) add("用語", old, next);
        }
        for (const word of words) {
          const formal = /^(?:(?:この|その|あの|どの))?(物|時|事|所|後|無い)(?:に|は|で|が|を|へ|も|と)?$/.exec(word.segment)?.[1];
          if (!formal || formal === "時" && /[0-9０-９一二三四五六七八九十百]$/.test(text.slice(0, word.index))) continue;
          // `${hour}時` のように差し込みの直後に来る「時」は時刻で、形式名詞ではない。
          if (formal === "時" && word.index === 0 && (ts.isTemplateMiddle(node) || ts.isTemplateTail(node))) continue;
          if (formal !== "無い" && /\p{Script=Han}$/u.test(text.slice(0, word.index))) continue;
          add("形式名詞", formal, ({ 物: "もの", 時: "とき", 事: "こと", 所: "ところ", 後: "あと", 無い: "ない" } as Record<string, string>)[formal]!);
        }
        for (const match of text.matchAll(/[^\x00-\x7f\s][ \t]+(?=[A-Za-z0-9])|[A-Za-z0-9][ \t]+(?=[^\x00-\x7f\s])/g)) add("空白", match[0], "数字・英字と日本語の間を空けない");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const path of files(sourceRoot)) {
  if (relative(sourceRoot, path).split(/[\\/]/)[0] === "ai" || path.endsWith("/agent-api.ts")) continue;
  scan(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS), path);
}

console.log(`画面の文字の指摘候補: ${findings.length}件（自動修正なし。動的に作る文は実画面で確認）`);
for (const finding of findings) console.log(`${finding.path}:${finding.line} [${finding.kind}] ${JSON.stringify(finding.word)} → ${finding.next} | ${finding.text}`);
