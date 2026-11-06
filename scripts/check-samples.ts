// node scripts/check-samples.ts <見本のscreensフォルダ> [調べるsrcの場所]
// 見本とsrcの静的な文を照合する。見本や結果はリポジトリに保存しない。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplesArg = process.argv[2];
if (!samplesArg) {
  console.error("使い方: node scripts/check-samples.ts <見本のscreensフォルダ> [srcの場所]");
  process.exit(2);
}
const samplesRoot = resolve(samplesArg);
const sourceRoot = resolve(process.argv[3] ?? resolve(root, "src"));
const compact = (text: string) => text.replace(/\s+/g, "");
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(resolve(path, entry.name)) : [resolve(path, entry.name)]).sort();
}
function decode(text: string) {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal: string, hex: string, named: string) => {
    if (decimal || hex) {
      const code = parseInt(decimal || hex, decimal ? 10 : 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[named?.toLowerCase()] ?? entity;
  });
}
function sampleText(html: string): string[] {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|title|script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const text = body.replace(/<[^>]+>/g, tag => {
    const attributes: string[] = [];
    const input = /^<input\b/i.test(tag) && !/\btype\s*=\s*["']?hidden\b/i.test(tag);
    for (const match of tag.matchAll(/\b(alt|placeholder|value|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      if (/^(?:alt|aria-label)$/i.test(match[1]!) || input) attributes.push(match[2] ?? match[3] ?? "");
    }
    if (attributes.length) return "\n" + attributes.join("\n") + "\n";
    return /^<\/?(?:p|div|section|article|main|header|footer|aside|form|h[1-6]|li|tr|td|th|caption|label|button|option|br)\b/i.test(tag) ? "\n" : "";
  });
  return [...new Set(decode(text).split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(line => /[\p{L}\p{N}]/u.test(line)))];
}
const attributes = new Set(["title", "alt", "placeholder", "aria-label", "label", "text"]);
function excluded(node: ts.Node, source: ts.SourceFile) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node || ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return !attributes.has(current.name.getText(source));
    if (ts.isPropertyAssignment(current) && /system|prompt|instruction/i.test(current.name.getText(source))) return true;
    if (ts.isVariableDeclaration(current) && /(?:^sql$|system|prompt|css|styles)/i.test(current.name.getText(source))) return true;
    if (ts.isVariableDeclaration(current) && current.name.getText(source) === "common" && /[/\\]draft[/\\]packs[/\\]/.test(source.fileName)) return true;
    if (ts.isJsxElement(current) && ["script", "style"].includes(current.openingElement.tagName.getText(source))) return true;
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const callee = current.expression.getText(source);
      if (/(?:^|\.)(?:prepare|exec)$/.test(callee) || /^console\./.test(callee) || callee === "RegExp" || /\.messages\.create$/.test(callee)) return true;
      if (current.arguments?.[0] === node && /\.(?:get|getAll|has|delete|includes|startsWith|endsWith|replace|replaceAll)$/.test(callee)) return true;
    }
  }
  return false;
}
function jsxText(node: ts.Node): string {
  if (ts.isJsxText(node)) return decode(node.text);
  if (ts.isJsxElement(node) && !["script", "style"].includes(node.openingElement.tagName.getText())) return node.children.map(jsxText).join("");
  if (ts.isJsxFragment(node)) return node.children.map(jsxText).join("");
  if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  return "\u0000"; // 動的な値をまたいで文が一致したことにしない。
}
const sourceText = new Set<string>();
function collect(source: ts.SourceFile) {
  function visit(node: ts.Node) {
    if (ts.isNoSubstitutionTemplateLiteral(node) && ts.isTaggedTemplateExpression(node.parent)
      && node.parent.tag.getText(source) === "String.raw" && /^\s*\(function\b/.test(node.text)) {
      collect(ts.createSourceFile(source.fileName + ".js", node.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
      return;
    }
    if (!excluded(node, source)) {
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) sourceText.add(compact(jsxText(node)));
      if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const jsx = ts.isJsxText(node) || ts.isJsxAttribute(node.parent);
        const label = ts.isPropertyAssignment(node.parent) && /^(?:title|label|text|alt|placeholder)$/.test(node.parent.name.getText(source));
        if ((jsx || label || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(node.text))
          && !/^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|CASE)\b/i.test(node.text)) sourceText.add(compact(jsx ? decode(node.text) : node.text));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const path of files(sourceRoot)) {
  if (!/\.tsx?$/.test(path) || /\.(?:test|d)\.tsx?$/.test(path) || path.endsWith("/testing.ts") || path.endsWith("/agent-api.ts") || relative(sourceRoot, path).split(/[\\/]/)[0] === "ai") continue;
  collect(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
}
const haystack = [...sourceText].join("\u0000");
const samples = files(samplesRoot).filter(path => path.endsWith(".dc.html"));
if (!samples.length) {
  console.error("見本の*.dc.htmlがありません。空の結果を照合済みにはしません。");
  process.exit(2);
}
const results = samples.map(path => {
  const html = readFileSync(path, "utf8");
  const texts = sampleText(html);
  const missing = texts.filter(text => !haystack.includes(compact(text)));
  const title = decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  return { file: relative(samplesRoot, path).replaceAll("\\", "/"), title, total: texts.length, missing };
});
console.log(`静的な文の照合: ${results.length}画面（動的な値や実際の表示は別に確認）`);
for (const result of results) {
  console.log(`\n${result.file} ${result.title} | 一致${result.total - result.missing.length} / 全${result.total} / 未一致${result.missing.length}`);
  for (const text of result.missing) console.log("- " + text);
}
console.log("\n文が一つも一致しない画面:");
const none = results.filter(result => result.total > 0 && result.total === result.missing.length);
for (const result of none) console.log(`${result.file} ${result.title}`);
if (!none.length) console.log("なし");
for (const result of results.filter(result => !result.total)) console.log(`${result.file}: 抽出できる文がありません`);
console.log("\n未一致が多い上位20画面:");
for (const result of [...results].sort((a, b) => b.missing.length - a.missing.length || a.file.localeCompare(b.file)).slice(0, 20)) console.log(`${result.file} ${result.title} | 未一致${result.missing.length} / 全${result.total}`);
