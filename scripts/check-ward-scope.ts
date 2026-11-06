import ts from "typescript";

/** 実行時の値や認証の正しさではなく、SQLに区の条件が書かれていることを調べる。 */
export interface ScopeIssue { file: string; line: number; message: string; sql?: string }
export interface ScopeException { file: string; sql: string; reason: string }

// ファイル全体を除外しない。SQLが変われば、改めて理由を確認する。
export const exceptions: readonly ScopeException[] = [
  { file: "src/ai/complete.ts", sql: "UPDATE jobs SET status = 'read', ticket_hash = NULL, updated_at = ? WHERE status = 'connecting' AND session_id IS NULL AND connect_started_at < ?", reason: "Cronが全区の、AI側の処理を開く前に止まった仕事を再開待ちへ戻す。本文は読み書きしない。" },
  { file: "src/ai/complete.ts", sql: "SELECT ward_id, job_id FROM jobs WHERE status = 'connecting' AND session_id IS NOT NULL AND connect_started_at < ? LIMIT 20", reason: "Cronが全区の確認待ちを拾い、以後は得られた区と仕事に絞って確認する。" },
  { file: "src/ai/complete.ts", sql: "SELECT DISTINCT ward_id, project_id FROM jobs WHERE status = 'read' AND project_id IS NOT NULL LIMIT 20", reason: "Cronが全区の接続待ちを拾い、以後は得られた区と行事に絞って処理する。" },
  { file: "src/ai/complete.ts", sql: "SELECT ward_id, job_id, session_id FROM jobs WHERE session_id IS NOT NULL AND session_deleted_at IS NULL AND status <> 'connecting' LIMIT 20", reason: "Cronが全区のAI側の消し残しを拾い、以後は得られた区と仕事に絞って消す。" },
  { file: "src/ai/webhook.ts", sql: "SELECT ward_id, job_id FROM jobs WHERE session_id = ?", reason: "署名を確かめたwebhookの宛先の解決。AI側の処理のIDから区を決める。" },
  { file: "src/archive/snapshot.ts", sql: "SELECT ward_id FROM wards WHERE ward_id IS NOT NULL ORDER BY ward_id", reason: "日次Cronが写しを作る区を列挙し、各表とR2はその区に絞って扱う。" },
  { file: "src/core/app.tsx", sql: "SELECT w.is_active FROM line_channels l JOIN wards w ON w.ward_id = l.ward_id WHERE w.ward_id IS NOT NULL AND l.destination = ? LIMIT 1", reason: "LINEのwebhookの宛先から停止中の区かを調べる。区の本文は返さない。" },
  { file: "src/core/ward.ts", sql: "SELECT ward_id, slug, name FROM wards WHERE slug = ?", reason: "区のURLから区を決める入口。以後の問い合わせのward_idをここで得る。" },
  { file: "src/intake/store.ts", sql: "SELECT ward_id, job_id FROM jobs WHERE attempt < ? AND ((status = 'received' AND updated_at < ?) OR (status = 'reading' AND lease_until < ?)) ORDER BY created_at LIMIT ?", reason: "Cronが全区の読み取りの停止を拾い、以後は得られた区と仕事に絞って再開する。" },
  { file: "src/intake/store.ts", sql: "UPDATE jobs SET status = 'failed', failure = 'error', lease_until = NULL, finished_at = ?, updated_at = ? WHERE attempt >= ? AND (status = 'received' OR (status = 'reading' AND lease_until < ?))", reason: "Cronが全区の試行上限に達した仕事の進み具合を更新する。本文は読み書きしない。" },
  { file: "src/line/index.tsx", sql: "SELECT DISTINCT l.ward_id, w.slug FROM line_channels l JOIN wards w ON w.ward_id = l.ward_id WHERE w.ward_id = l.ward_id AND w.is_active = 1", reason: "Cronが公式LINEにつながる稼働中の区を列挙し、以後は区ごとに処理する。" },
  { file: "src/line/index.tsx", sql: "SELECT DISTINCT ward_id FROM line_photo_context_texts WHERE ward_id IS NOT NULL", reason: "Cronが一時的な文のある区を列挙し、接続を外した区も含め、区ごとに期限切れを消す。" },
  { file: "src/line/webhook.ts", sql: "SELECT ward_id FROM line_channels WHERE destination = ?", reason: "LINEのwebhookの宛先から区を解決する。続いてその区の署名を確かめる。" },
  { file: "src/ops/index.tsx", sql: "SELECT ward_id, slug, name FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ?)", reason: "認証済みの運用の画面が、URLで選んだ区を解決する。" },
  { file: "src/ops/lifecycle-pages.tsx", sql: "SELECT ward_id, slug, name, is_active FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ?)", reason: "認証済みの運用の画面が、記録を扱う区をURLから解決する。" },
  { file: "src/ops/lifecycle-pages.tsx", sql: "SELECT target_type, state, requested_at, completed_at, last_error FROM ops_deletion_queue WHERE ward_id IS NOT NULL ORDER BY requested_at DESC LIMIT 100", reason: "認証済みの提供側だけが見る、全区の消去処理の進み具合。" },
  { file: "src/ops/lifecycle-pages.tsx", sql: "SELECT scope, deleted_at FROM ops_deletion_marks WHERE ward_id IS NOT NULL ORDER BY deleted_at DESC LIMIT 100", reason: "認証済みの提供側だけが見る、全区の消去した日時の一覧。" },
  { file: "src/ops/lifecycle.ts", sql: "SELECT queue_id, ward_id, target_type, target_id, cursor FROM ops_deletion_queue WHERE ward_id IS NOT NULL AND state IN ('pending', 'running', 'error') ORDER BY CASE state WHEN 'error' THEN 1 ELSE 0 END, requested_at LIMIT 1", reason: "Cronが全区の消去待ちから一つ拾い、続きの消去は得られた区に絞る。" },
  { file: "src/ops/wards.ts", sql: "SELECT w.ward_id, w.slug, w.name, w.created_at, (SELECT COUNT(*) FROM accounts a WHERE a.ward_id = w.ward_id AND a.removed_at IS NULL) AS account_count, (SELECT COUNT(*) FROM jobs j WHERE j.ward_id = w.ward_id AND j.status IN ('failed', 'attention') AND j.withdrawn_at IS NULL) AS attention_count FROM wards w WHERE w.ward_id IS NOT NULL ORDER BY w.created_at, w.slug", reason: "認証済みの提供側の区の一覧。件数の集計は一覧の各区に結び付ける。" },
  { file: "src/seo/index.ts", sql: "SELECT ward_id, slug FROM wards WHERE ward_id IS NOT NULL AND is_active = 1 ORDER BY slug", reason: "sitemapが稼働中の区の公開URLを列挙する。配った内容は区ごとに絞って引く。" },
];

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const sqlStart = /^\s*\(*\s*(?:select|insert|update|delete|with)\b/i;
const hole = "__dynamic__";
const product = (a: string[], b: string[], join = "") => [...new Set(a.flatMap((x) => b.map((y) => x + join + y)))];

/** 文字列のコメントと値を条件と取り違えないためのSQL字句分解。 */
function tokens(sql: string): string[] {
  return [...sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|\?\d*|[:@$][a-z_0-9]+|\d+(?:\.\d+)?|==|!=|<>|<=|>=|[^\s]/gi)]
    .map(([s]) => s).filter((s) => !s.startsWith("--") && !s.startsWith("/*"))
    .map((s) => /^["`\[]/.test(s) ? s.slice(1, -1).toLowerCase() : s.toLowerCase());
}

function closeAt(t: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === "(") depth++;
    if (t[i] === ")" && --depth === 0) return i;
  }
  return t.length;
}

function splitTop(t: string[], separator: string): string[][] {
  const parts: string[][] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") i = closeAt(t, i);
    else if (t[i] === separator) { parts.push(t.slice(start, i)); start = i + 1; }
  }
  parts.push(t.slice(start));
  return parts;
}

// ANDは全条件、ORは全ての分岐にある条件だけを採る。SELECTやSET中のward_idは条件にしない。
function equalities(input: string[]): string[][] {
  let t = input;
  while (t[0] === "(" && closeAt(t, 0) === t.length - 1) t = t.slice(1, -1);
  const alternatives = splitTop(t, "or");
  if (alternatives.length > 1) {
    const facts = alternatives.map(equalities);
    return (facts[0] ?? []).filter((fact) => facts.every((branch) => branch.some((other) => other.join("=") === fact.join("="))));
  }
  const both = splitTop(t, "and");
  if (both.length > 1) return both.flatMap(equalities);
  const at = t.findIndex((s) => s === "=" || s === "==");
  if (at < 0 || t.includes("select") || t[0] === "not") return [];
  const left = t.slice(0, at).join("");
  const right = t.slice(at + 1).join("");
  return /^[a-z_][\w.]*$/.test(left) && /^(?:[a-z_][\w.]*|\?\d*|[:@$]\w+|'[^']*'|\d+)$/.test(right)
    ? [[left, right].sort()] : [];
}

interface Binding { table: string; alias: string; joined: boolean; nullable: boolean; on: string[] }
const reserved = new Set(["where", "join", "left", "right", "full", "inner", "outer", "cross", "on", "using", "set", "group", "order", "limit", "returning", "union", "having", ",", ";", ")"]);

/** SQLごと、入れ子ごと、UNIONの枝ごとに条件を調べる。 */
export function inspectSql(sql: string, wardTables: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const inspect = (input: string[], outer: ReadonlySet<string>) => {
    let t = input;
    while (t[0] === "(" && closeAt(t, 0) === t.length - 1) t = t.slice(1, -1);
    for (const separator of [";", "union", "intersect", "except"]) {
      const pieces = splitTop(t, separator);
      if (pieces.length > 1) { for (const piece of pieces) if (piece.length) inspect(piece[0] === "all" ? piece.slice(1) : piece, outer); return; }
    }
    const children: string[][] = [];
    const flat: string[] = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") {
        const end = closeAt(t, i);
        const inner = t.slice(i + 1, end);
        if (inner[0] === "select" || inner[0] === "with") { children.push(inner); flat.push("__subquery__"); i = end; continue; }
      }
      flat.push(t[i]!);
    }
    const bindings: Binding[] = [];
    let depth = 0;
    let inFrom = false;
    for (let i = 0; i < flat.length; i++) {
      const word = flat[i];
      if (word === "(") depth++;
      if (word === ")") depth--;
      if (depth !== 0) continue;
      if (word === "from") inFrom = true;
      if (["where", "group", "order", "limit", "returning"].includes(word ?? "")) inFrom = false;
      if (inFrom && word === ",") problems.push("カンマでつなぐ表はJOINと区の条件を個別に確認してください");
      // 読めない式をWHEREやSELECTの代わりにして、検査を素通りさせない。
      if (word?.includes(hole) && word[0] !== "'" && !["from", "join", "update", "into"].includes(flat[i - 1] ?? "") && !(flat[i + 1] === "=" && ["set", ","].includes(flat[i - 1] ?? ""))) {
        problems.push("SQLに判定できない組み立てがあります");
      }
      if (word === "from" || word === "join" || (i === 0 && word === "update")) {
        const table = flat[i + 1];
        if (!table || table === "__subquery__") continue;
        if (table !== hole && !wardTables.has(table) && !["archive_search_fts", "json_each"].includes(table)) {
          problems.push(`表${table}の区の条件を判定できません`);
        }
        let next = i + 2;
        if (flat[next] === "as") next++;
        const alias = flat[next] && !reserved.has(flat[next]!) && /^[a-z_]\w*$/.test(flat[next]!) ? flat[next]! : table;
        const onStart = flat.indexOf("on", next);
        let onEnd = onStart + 1;
        while (onEnd < flat.length && !["join", "left", "right", "inner", "cross", "where", "group", "order", "limit"].includes(flat[onEnd]!)) onEnd++;
        bindings.push({ table, alias, joined: word === "join", nullable: ["left", "right", "full", "outer"].includes(flat[i - 1] ?? ""), on: word === "join" && onStart >= 0 ? flat.slice(onStart + 1, onEnd) : [] });
      }
    }
    const scoped = bindings.filter((b) => wardTables.has(b.table) || b.table === hole);
    let where = -1;
    depth = 0;
    for (let i = 0; i < flat.length; i++) {
      if (flat[i] === "(") depth++;
      else if (flat[i] === ")") depth--;
      else if (!depth && flat[i] === "where") { where = i; break; }
    }
    let end = flat.length;
    if (where >= 0) for (let i = where + 1; i < flat.length; i++) {
      if (["group", "order", "limit", "returning"].includes(flat[i]!)) { end = i; break; }
    }
    const facts = equalities(where < 0 ? [] : flat.slice(where + 1, end));
    const qualified = (name: string): string => name === "ward_id" && scoped.length === 1 ? `${scoped[0]!.alias}.ward_id` : name;
    const localNames = new Set(bindings.map((b) => `${b.alias}.ward_id`));
    const reached = new Set([...outer].filter((name) => !localNames.has(name)));
    const edges: string[][] = [];
    const addFacts = (pairs: string[][]) => {
      for (const pair of pairs) {
        const a = qualified(pair[0]!); const b = qualified(pair[1]!);
        if (a.endsWith(".ward_id") && b.endsWith(".ward_id")) { if (a !== b) edges.push([a, b]); }
        else if (a.endsWith(".ward_id") && /^(?:\?|[:@$]|'|\d)/.test(b)) reached.add(a);
        else if (b.endsWith(".ward_id") && /^(?:\?|[:@$]|'|\d)/.test(a)) reached.add(b);
      }
    };
    addFacts(facts);
    // 結合のONだけで親の全区を許可しない。子への伝播にだけ使う。
    const propagate = () => {
      for (let n = 0; n <= scoped.length + outer.size; n++) for (const [a, b] of edges) {
        if (reached.has(a!)) reached.add(b!);
        if (reached.has(b!)) reached.add(a!);
      }
    };
    for (const b of scoped.filter((b) => b.joined && !b.nullable)) addFacts(equalities(b.on));
    propagate();
    const roots = scoped.filter((b) => !b.joined);
    for (const b of roots) if (!reached.has(`${b.alias}.ward_id`)) problems.push(`${b.table}(${b.alias})にward_idの絞りがありません`);
    for (const b of scoped.filter((b) => b.joined)) {
      const on = equalities(b.on);
      const linked = on.some((pair) => pair.includes(`${b.alias}.ward_id`) && pair.some((v) => v !== `${b.alias}.ward_id` && v.endsWith(".ward_id")));
      // 全文索引にはward_idが無い。実体の表をWHEREで絞ってからrowidでつなぐ。
      const ftsJoin = bindings.some((other) => other.table === "archive_search_fts") && b.table === "archive_search_entries" && reached.has(`${b.alias}.ward_id`) && b.on.join("").includes(`${b.alias}.entry_id=archive_search_fts.rowid`);
      if (!linked && !ftsJoin) problems.push(`${b.table}(${b.alias})のJOINにward_idの結び付けがありません`);
      if (b.nullable) {
        for (const pair of on) if (pair.includes(`${b.alias}.ward_id`) && pair.some((value) => value !== `${b.alias}.ward_id` && reached.has(value))) reached.add(`${b.alias}.ward_id`);
      }
      propagate();
      if (!reached.has(`${b.alias}.ward_id`)) problems.push(`${b.table}(${b.alias})にward_idの絞りがありません`);
    }
    if (flat[0] === "insert") {
      const into = flat.indexOf("into"); const table = flat[into + 1]; const start = into + 2;
      if (!table || !wardTables.has(table)) problems.push(`INSERT先${table ?? "不明"}を判定できません`);
      const stop = closeAt(flat, start);
      const columns = splitTop(flat.slice(start + 1, stop), ",");
      const index = columns.findIndex((c) => c.join("") === "ward_id");
      if (flat[start] !== "(" || index < 0) problems.push(`${table}のINSERTにward_idがありません`);
      else {
        const valuesAt = flat.indexOf("values", stop);
        const selectAt = flat.indexOf("select", stop);
        if (valuesAt >= 0) {
          let i = valuesAt + 1;
          while (flat[i] === "(") {
            const last = closeAt(flat, i); const value = splitTop(flat.slice(i + 1, last), ",")[index]?.join("");
            if (!value || value === "null" || value === "''") problems.push(`${table}のINSERTのward_idに値がありません`);
            i = last + 1; if (flat[i] === ",") i++;
          }
          if (flat[valuesAt + 1] !== "(") problems.push(`${table}のINSERTの値を判定できません`);
        } else if (selectAt >= 0) {
          const last = flat.indexOf("from", selectAt);
          const value = splitTop(flat.slice(selectAt + 1, last < 0 ? where < 0 ? flat.length : where : last), ",")[index]?.join("");
          if (!value || value === "null" || value === "''") problems.push(`${table}のINSERTのward_idに値がありません`);
        } else problems.push(`${table}のINSERTの値を判定できません`);
      }
      // UPSERTが別の区へ移さないこと。衝突の対象にもward_idが必要。
      const conflict = flat.indexOf("conflict");
      if (conflict >= 0 && flat.includes("update", conflict)) {
        const target = flat.slice(conflict + 1, closeAt(flat, conflict + 1) + 1);
        if (!target.includes("ward_id")) problems.push(`${table}のON CONFLICTにward_idがありません`);
      }
    }
    for (const child of children) inspect(child, reached);
    if (t[0] === "with") problems.push("WITHの問い合わせは個別の確認が必要です");
  };
  inspect(tokens(sql), new Set());
  return [...new Set(problems)];
}

/** ファイルの読み取りを分け、CLIとNode.jsの試験で同じ検査を呼ぶ。 */
export function checkWardScope(sources: Record<string, string>, migrations: Record<string, string>, allowed: readonly ScopeException[] = exceptions) {
  const wardTables = new Set<string>();
  for (const sql of Object.values(migrations)) {
    const t = tokens(sql);
    for (let i = 0; i < t.length; i++) if (t[i] === "create" && t[i + 1] === "table") {
      const nameAt = t[i + 2] === "if" ? i + 5 : i + 2;
      const columns = splitTop(t.slice(nameAt + 2, closeAt(t, nameAt + 1)), ",");
      if (columns.some((column) => column[0] === "ward_id")) wardTables.add(t[nameAt]!);
    }
  }
  const files = new Map(Object.entries(sources).map(([name, text]) => [name.replaceAll("\\", "/"), ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)]));
  const host: ts.CompilerHost = {
    getSourceFile: (name) => files.get(name), getDefaultLibFileName: () => "lib.d.ts", writeFile: () => {},
    getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name)?.text, getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, containing) => names.map((name) => {
      const parts = containing.split("/"); parts.pop();
      for (const part of name.split("/")) { if (part === "..") parts.pop(); else if (part !== ".") parts.push(part); }
      const base = parts.join("/"); const file = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((p) => files.has(p));
      return file ? { resolvedFileName: file } : undefined;
    }),
  };
  const program = ts.createProgram([...files.keys()], { noLib: true, noResolve: false, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  function strings(node: ts.Node, seen = new Set<ts.Node>()): string[] {
    if (seen.has(node)) return [hole];
    seen = new Set(seen).add(node);
    const read = (n: ts.Node) => strings(n, seen);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return read(node.expression);
    if (ts.isConditionalExpression(node)) return [...read(node.whenTrue), ...read(node.whenFalse)];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return product(read(node.left), read(node.right));
    if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((out, span) => product(out, read(span.expression)).map((s) => s + span.literal.text), [node.head.text]);
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return read(declaration.initializer);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text; const receiver = node.expression.expression;
      if (method === "replace" || method === "replaceAll") {
        const from = node.arguments[0]; const to = node.arguments[1];
        if (from && to && ts.isStringLiteralLike(from) && ts.isStringLiteralLike(to)) return read(receiver).map((s) => method === "replace" ? s.replace(from.text, to.text) : s.replaceAll(from.text, to.text));
      }
      if (method === "join") {
        const separator = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : ",";
        let array: ts.Node = receiver;
        if (ts.isIdentifier(array)) {
          const declaration = checker.getSymbolAtLocation(array)?.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) array = declaration.initializer;
        }
        if (ts.isArrayLiteralExpression(array)) return array.elements.reduce<string[]>((out, element, i) => product(out, read(element), i ? separator : ""), [""]);
        if (ts.isCallExpression(array) && ts.isPropertyAccessExpression(array.expression) && array.expression.name.text === "map") {
          const callback = array.arguments[0];
          if (callback && ts.isArrowFunction(callback)) return read(callback.body);
        }
      }
    }
    return [hole];
  }
  const issues: ScopeIssue[] = [];
  const queries: { file: string; line: number; sql: string }[] = [];
  let r2References = 0; let prepared = 0;
  const used = new Set<ScopeException>();
  for (const [file, source] of files) {
    if (file.endsWith(".sql")) {
      queries.push({ file, line: 1, sql: source.text });
      const exemption = allowed.find((e) => e.file === file && normalize(e.sql) === normalize(source.text) && e.reason.trim());
      if (exemption) used.add(exemption);
      else for (const message of inspectSql(source.text, wardTables)) issues.push({ file, line: 1, message, sql: source.text });
      continue;
    }
    const line = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
    const query = (node: ts.Node, required: boolean) => {
      const variants = strings(node);
      if (required && variants.some((sql) => !sqlStart.test(sql))) issues.push({ file, line: line(node), message: "SQLの組み立てを判定できません" });
      for (const sql of variants.filter((s) => sqlStart.test(s))) {
        if (queries.some((q) => q.file === file && q.line === line(node) && q.sql === sql)) continue;
        queries.push({ file, line: line(node), sql });
        const exemption = allowed.find((e) => e.file === file && normalize(e.sql) === normalize(sql) && e.reason.trim());
        if (exemption) { used.add(exemption); continue; }
        for (const message of inspectSql(sql, wardTables)) issues.push({ file, line: line(node), message, sql });
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && (node.expression.name.text === "prepare" || node.expression.name.text === "exec" && /\b(?:DB|db|database)\b/.test(node.expression.expression.getText(source)))) {
        prepared++; const arg = node.arguments[0];
        if (arg) query(arg, true); else issues.push({ file, line: line(node), message: "SQLがありません" });
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && sqlStart.test(ts.isTemplateExpression(node) ? node.head.text : node.text)) {
        let root: ts.Node = node;
        while (ts.isConditionalExpression(root.parent) || ts.isBinaryExpression(root.parent) && root.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) root = root.parent;
        // 上の問い合わせに含まれる枝や、埋め込む式は完成した文字列で調べる。
        let parent: ts.Node | undefined = root.parent; let nested = false;
        while (parent) { if (ts.isTemplateExpression(parent)) nested = true; parent = parent.parent; }
        if (!nested) query(root, false);
      }
      const originals = ts.isPropertyAccessExpression(node) && node.name.text === "ORIGINALS" ||
        ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "ORIGINALS";
      if (originals) {
        r2References++;
        const parent = node.parent;
        if (!(ts.isNewExpression(parent) && parent.expression.getText(source) === "WardBucket" && parent.arguments?.[0] === node)) {
          issues.push({ file, line: line(node), message: "ORIGINALSをWardBucketに渡さず直接使っています" });
        }
      }
      if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source).replace(/['"]/g, "") === "ORIGINALS") {
        issues.push({ file, line: line(node), message: "ORIGINALSの取り出しはWardBucketへ直接渡してください" });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const entry of allowed) if (!used.has(entry)) issues.push({ file: entry.file, line: 1, message: `使われていない例外です: ${entry.reason}` });
  if (!wardTables.size || !prepared || !queries.length) issues.push({ file: "src", line: 1, message: "表またはSQLを読み取れませんでした" });
  return { issues, queries, prepared, r2References, wardTables: wardTables.size, exceptions: used.size };
}

async function main() {
  const { readdir, readFile } = await import("node:fs/promises");
  const { URL } = await import("node:url");
  const root = new URL("../", import.meta.url);
  const load = async (directory: string, extension: RegExp) => {
    const result: Record<string, string> = {};
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(new URL(path, root), { withFileTypes: true })) {
        const name = `${path}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`${name}: リンクは読みません`);
        if (entry.isDirectory()) await walk(name);
        else if (extension.test(name)) result[name] = await readFile(new URL(name, root), "utf8");
      }
    };
    await walk(directory); return result;
  };
  const [sources, migrations] = await Promise.all([load("src", /\.(?:[cm]?ts|tsx|[cm]?js|jsx|sql)$/), load("migrations", /\.sql$/)]);
  const result = checkWardScope(sources, migrations);
  for (const issue of result.issues) console.error(`${issue.file}:${issue.line}: ${issue.message}${process.argv.includes("--details") && issue.sql ? `\n  ${normalize(issue.sql)}` : ""}`);
  console.log(`区の検査: ${Object.keys(sources).length}ファイル、${result.wardTables}表、prepare ${result.prepared}件、SQL ${result.queries.length}通り、R2 ${result.r2References}箇所、理由付き例外${result.exceptions}件、問題${result.issues.length}件`);
  if (result.issues.length) process.exitCode = 1;
}

if (typeof process !== "undefined" && process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/check-ward-scope.ts")) {
  await main();
}
