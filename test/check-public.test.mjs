// 全て架空の文字列を一時リポジトリだけに置く。検出した値を出力しないことまで確かめる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/check-public.ts", import.meta.url));
function fixture(t) {
  const area = mkdtempSync(join(tmpdir(), "sasae-public-check-"));
  const root = join(area, "repo");
  mkdirSync(root);
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, "架空リポジトリのGit操作に失敗しました");
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "試験担当（架空）");
  git("config", "user.email", "fixture@example.invalid");
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = (message = "架空の試験") => { git("add", "."); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  const run = (args = [], extra = {}, cwd = root) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, PUBLIC_CHECK_CONFIG: "", PUBLIC_CHECK_TERMS: "", ...extra },
    });
    return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
  };
  const reference = "架空の管理文書の照合用に十分長い文章を作っています。これは試験用の原本であり実在の資料から取っていません。改行や空白が変わっても同じ長文を見つけます。役員のための架空の説明をさらに続けて必要な長さにします。";
  const referenceFile = join(area, "reference.txt");
  writeFileSync(referenceFile, reference);
  const configFile = join(area, "check.json");
  const config = { terms: { affiliation: [], municipality: [], participant: [], benefitCode: [] }, referenceFiles: [referenceFile] };
  const saveConfig = () => writeFileSync(configFile, JSON.stringify(config));
  saveConfig();
  return { area, root, git, put, commit, run, reference, config, configFile, saveConfig };
}

test("消えたファイル、別の枝、mergeだけの本文、作業ツリー、commitとauthorを読み、検出値を伏せる", (t) => {
  const f = fixture(t);
  const token = "gh" + "p_" + "A".repeat(36);
  const mergeToken = "sk-" + "ant-" + "B".repeat(40);
  const email = `fictional-officer@fictional-${crypto.randomUUID()}.com`;
  const affiliation = "架空の所属ABC";
  const municipality = "架空の自治体XYZ";
  const participant = "架空の参加者UVW";
  const benefit = "FICTIONAL-BENEFIT-1234";
  Object.assign(f.config.terms, { affiliation: [affiliation], municipality: [municipality], participant: [participant], benefitCode: [benefit] });
  f.saveConfig();
  f.git("config", "user.email", email);
  f.put("old/record.txt", [token, affiliation, municipality, participant, `特典コード: ${benefit}`, `CLOUDFLARE_API_TOKEN=${"Q".repeat(40)}`, "-----BEGIN " + "PRIVATE KEY-----", f.reference.replaceAll("。", "。\n")].join("\n"));
  f.put("shared.txt", "架空の共通ファイル");
  f.put(".gitignore", ".env.local\n");
  f.put("binary.dat", Buffer.from([0, 1, 2, 255]));
  const first = f.commit(`架空の記録\n\n${participant}\n${email}`);
  f.git("checkout", "-q", "-b", "side");
  f.put("docs/EVIDENCE/fictional.md", `https://example.invalid/private/${crypto.randomUUID()}\nproject_id: fictional-project-1234`);
  f.put("shared.txt", "右の架空の内容");
  f.commit();
  f.git("checkout", "-q", "main");
  f.git("rm", "-q", "old/record.txt");
  f.put("shared.txt", "左の架空の内容");
  f.commit();
  const conflict = spawnSync("git", ["-C", f.root, "merge", "--no-ff", "side", "-m", "架空の結合"], { encoding: "utf8" });
  assert.equal(conflict.status, 1);
  f.put("shared.txt", mergeToken);
  const merged = f.commit();
  f.git("checkout", "-q", "-b", "off-main", first);
  f.put("branch-only.txt", token);
  const side = f.commit();
  f.git("checkout", "-q", "main");
  const stagedToken = "gh" + "o_" + "C".repeat(36);
  f.put("staged-only.txt", stagedToken);
  f.git("add", "staged-only.txt");
  f.put("staged-only.txt", "作業中の架空の文書");
  f.put(`new/${municipality}.txt`, participant);
  f.put(".env.local", token); // Gitの除外設定にある未追跡ファイルは公開対象に含めない。
  symlinkSync(f.configFile, join(f.root, "outside-link")); // 参照先の原本をたどらない。
  const before = f.git("rev-parse", "HEAD");
  const result = f.run(["--config", f.configFile]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.incomplete, []);
  for (const value of [token, mergeToken, stagedToken, email, affiliation, municipality, participant, benefit, f.reference, f.configFile]) {
    assert.equal((result.stdout + result.stderr).includes(value), false, "検出値か外部パスが出力されました");
  }
  for (const kind of ["credential", "credential-assignment", "private-key", "email", "affiliation", "municipality", "participant", "benefit-code", "management-copy", "evidence-url", "evidence-id"]) {
    assert.ok(result.report.counts[kind] > 0, `未検出: ${kind}`);
  }
  const found = result.report.findings;
  assert.ok(found.some((x) => x.source === "history" && x.path === "old/record.txt" && x.commit === first));
  assert.ok(found.some((x) => x.source === "history" && x.path === "branch-only.txt" && x.commit === side));
  assert.ok(found.some((x) => x.source === "history" && x.path === "shared.txt" && x.commit === merged));
  assert.ok(found.some((x) => x.source === "commit" && x.kind === "email"));
  assert.ok(found.some((x) => x.source === "index" && x.path === "staged-only.txt" && x.kind === "credential"));
  assert.ok(found.some((x) => x.source === "tree" && x.path.startsWith("[path:")));
  assert.equal(found.some((x) => x.source === "tree" && [".env.local", "outside-link"].includes(x.path)), false);
  assert.ok(result.report.limits.binaryTree > 0 && result.report.limits.binaryHistory > 0);
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(readFileSync(join(f.root, "shared.txt"), "utf8"), mergeToken);
});

test("照合語と原本が未指定なら未確認を返し、架空のメールだけの完成した設定なら候補なしになる", (t) => {
  const f = fixture(t);
  f.put("README.md", "試験用の連絡先: sample@example.invalid\n架空の文書です。");
  f.commit();
  const missing = f.run();
  assert.equal(missing.status, 2);
  assert.equal(missing.report.incomplete.length, 5);
  const complete = f.run([], { PUBLIC_CHECK_CONFIG: f.configFile, PUBLIC_CHECK_TERMS: JSON.stringify(f.config.terms) });
  assert.equal(complete.status, 0);
  assert.deepEqual(complete.report.findings, []);
  assert.deepEqual(complete.report.incomplete, []);
});

test("リポジトリ内の設定と壊れた環境入力を拒み、中身を出力しない", (t) => {
  const f = fixture(t);
  f.put("README.md", "架空の試験");
  f.commit();
  f.put("private-config.json", JSON.stringify(f.config));
  const inside = f.run(["--config", join(f.root, "private-config.json")]);
  assert.equal(inside.status, 2);
  assert.equal(inside.stdout, "");
  f.put("..private-config.json", JSON.stringify(f.config));
  assert.equal(f.run(["--config", join(f.root, "..private-config.json")]).status, 2);
  const invalid = "fictional-confidential-input-" + "Q".repeat(40);
  const result = f.run([], { PUBLIC_CHECK_TERMS: invalid });
  assert.equal(result.status, 2);
  assert.equal((result.stdout + result.stderr).includes(invalid), false);
});

test("浅い取得では、現在のファイルに候補がなくても全履歴の確認済みにならない", (t) => {
  const f = fixture(t);
  f.put("old.txt", "架空の古い文書");
  f.commit();
  f.git("rm", "-q", "old.txt");
  f.put("README.md", "架空の新しい文書");
  f.commit();
  const clone = join(f.area, "shallow");
  const cloned = spawnSync("git", ["clone", "-q", "--depth=1", new URL(`file://${f.root}`).href, clone], { encoding: "utf8" });
  assert.equal(cloned.status, 0);
  const result = f.run(["--config", f.configFile], {}, clone);
  assert.equal(result.status, 2);
  assert.equal(result.report.scope.shallow, true);
  assert.ok(result.report.incomplete.some((message) => message.includes("浅い取得")));
});
