import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { LOCAL_FLOW } from "../fixtures/line-sim/local-flow";
import { outcomeMatches, runSimulation, type Query, type SimOptions, type SqlRow } from "../scripts/line-sim";
import { setClientFactory } from "../src/ai/deps";
import { MATCH_UNRELATED } from "../src/ai/match";
import { listAnswers, replaceRoster } from "../src/answers/api";
import { createApp } from "../src/core/app";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import type { AppEnv } from "../src/env";
import { createLineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createProject } from "../src/project/api";
import { withEnv } from "./helpers";

it("U38: 署名した試しの文をローカルのWorkersへ送り、D1と原文を読み、返事が失敗しても次の文を受ける", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: LOCAL_FLOW.projectTitle, year: 2026, accountId: account.accountId });
  await replaceRoster(env.DB, ward.wardId, LOCAL_FLOW.roster, { household: 0, district: 1 });
  const options: SimOptions = { base: "http://localhost:8787", ward: ward.slug, wardId: ward.wardId, destination: `U${"0".repeat(32)}`,
    secret: "fictional-u38-secret", accessToken: "fictional-u38-token", remote: false, waitMs: 1000 };
  const runtime = withEnv({ LINE_SIM_CHANNEL_SECRET: options.secret, LINE_SIM_CHANNEL_ACCESS_TOKEN: options.accessToken });
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_SIM_CHANNEL_SECRET', 'LINE_SIM_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, options.destination).run();
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  // AIとLINEへの通信だけを偽物にし、受付、署名、D1、R2、出欠の保存は実装を通す。
  const ai = new Anthropic({ apiKey: "fictional-u38-ai", maxRetries: 0, fetch: async () =>
    Response.json({ error: { type: "overloaded_error", message: "fictional unavailable" } }, { status: 529 }) });
  let replyFailures = 0;
  const fakeLine: typeof fetch = async (input) => {
    if (String(input).endsWith("/message/reply")) replyFailures++;
    return Response.json({ message: "fictional unauthorized" }, { status: 401 });
  };
  const intake = createLineIntakePorts(runtime, ctx, async (_wardId, original) => ({
    choice: original.text === "おはようございます。" ? MATCH_UNRELATED : project.projectId,
    reason: "試しのAIの判断です。", intent: /何時からですか/.test(original.text ?? "") ? "inquiry" : "material", attendanceAnswer: /参加します|行きます|参加しません/.test(original.text ?? ""),
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const hooks = new Hono<AppEnv>();
  hooks.post("/line", (c) => acceptLineWebhook(c.req.raw, runtime, env.DB, { ports: intake, fetch: fakeLine }, new Date(), ctx));
  const app = createApp([{ hooks }]);
  const reportCopies: string[] = [];
  const sqlCopies: string[] = [];
  let posts = 0;
  const query: Query = async (sql) => {
    sqlCopies.push(sql);
    expect(sql).toContain("ward_id");
    return (await env.DB.prepare(sql).all<SqlRow>()).results;
  };
  const requester: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/hooks/line");
    expect(init?.redirect).toBe("manual");
    posts++;
    return app.request(new Request(url, init), undefined, runtime);
  };
  const ports = { query, fetch: requester, sleep: async () => { await Promise.resolve(); }, record: async (report: string) => { reportCopies.push(report); } };
  setClientFactory(() => ai);
  try {
    await expect(runSimulation({ ...options, ward: "demoku" }, LOCAL_FLOW, ports)).rejects.toThrow("demoku");
    expect(posts).toBe(0);
    await expect(runSimulation({ ...options, wardId: other.ward.wardId }, LOCAL_FLOW, ports)).rejects.toThrow("区とチャネル");
    expect(posts).toBe(0);
    // 別の用件を独立した送信者で流す。同じ人の続けての投稿はU78で確かめる。
    const independentFlow = { ...LOCAL_FLOW, scenes: LOCAL_FLOW.scenes.map((scene) => ({ ...scene, talk: scene.id })) };
    const result = await runSimulation(options, independentFlow, ports);
    expect(result).toEqual({ matched: 8, total: 8 });
    expect(posts).toBe(8);
    expect(replyFailures).toBe(1);
    const report = reportCopies.at(-1);
    expect(report).toContain("合った文: 8/8");
    expect(report).toContain('"replied":0');
    expect(report).not.toContain(options.secret);
    expect(report).not.toContain(options.accessToken);
    const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
    expect(answers).toHaveLength(4);
    expect(answers.map((a) => [a.household, a.district, a.peopleCount])).toEqual(expect.arrayContaining([
      ["同名一郎", "2班", 3], ["同名一郎", "", 1], ["欠席一郎", "1班", 0],
    ]));
    const originals = await env.DB.prepare("SELECT r2_path FROM originals WHERE ward_id = ? AND withdrawn_at IS NULL").bind(ward.wardId).all<{ r2_path: string }>();
    const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
    const saved = await Promise.all(originals.results.map(async (o) => (await bucket.get(o.r2_path))?.text()));
    expect(saved).toContain(LOCAL_FLOW.scenes[1]!.messages[0]!.text);
    expect(saved).not.toContain("おはようございます。");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM project_answers WHERE ward_id = ?").bind(other.ward.wardId).first("n")).toBe(0);
    // HTTP200や違う人数だけでは一致にならない。
    const answerSql = sqlCopies.filter((sql) => sql.includes("AS answer_project_id") && sql.includes("-attend-")).at(-1);
    if (!answerSql) throw new Error("答えの確認記録がありません。");
    const row = (await query(answerSql))[0];
    if (!row) throw new Error("答えの保存結果がありません。");
    expect(outcomeMatches({ kind: "答えに数える", household: "参加一郎", district: "1班", people: 99 }, row, project.projectId, false)).toBe(false);
    expect(outcomeMatches({ kind: "答えに数える", household: "参加一郎", district: "1班", people: 2 }, { receipt: 1 }, project.projectId, false)).toBe(false);
    await Promise.all(pending);
  } finally {
    await Promise.allSettled(pending);
    setClientFactory(null);
  }
}, 60000);

it.each([302, 307])("U38: HTTP%sなら転送先へ送らず、後の文も送らない", async (status) => {
  const options: SimOptions = { base: "http://localhost:8787", ward: "fictional-redirect", wardId: "fictional-redirect",
    destination: `U${"0".repeat(32)}`, secret: "fictional-redirect-secret", accessToken: "fictional-redirect-token", remote: false, waitMs: 1000 };
  const reportCopies: string[] = [];
  const query: Query = async (sql) => {
    if (sql.includes("AS prior_answers")) return [{ slug: options.ward, name: "試しの区", channel_secret_binding: "LINE_SIM_CHANNEL_SECRET",
      access_token_binding: "LINE_SIM_CHANNEL_ACCESS_TOKEN", project_id: "fictional-project", prior_answers: 0 }];
    if (sql.includes("FROM ward_roster_entries")) return LOCAL_FLOW.roster;
    if (sql.includes("FROM line_unrelated_daily_counts")) return [{ count: 0 }];
    throw new Error("送信が失敗したあとは保存結果を照合しません。");
  };
  let posts = 0;
  const requester: typeof fetch = async (input, init) => {
    // WorkersのRequestを実際に作り、対応する転送設定のまま受け付ける。
    const request = new Request(String(input), init);
    expect(request.url).toBe("http://localhost:8787/hooks/line");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    posts++;
    return new Response(null, { status, headers: { location: "https://fictional-redirect.invalid/hooks/line" } });
  };
  const sleep = async () => { throw new Error("送信が失敗したあとは次の文を待ちません。"); };
  await expect(runSimulation(options, LOCAL_FLOW, { query, fetch: requester, sleep,
    record: async (report) => { reportCopies.push(report); },
  })).rejects.toThrow("受け口が成功を返しませんでした。");
  expect(posts).toBe(1);
  const report = reportCopies.at(-1);
  expect(report).toContain("停止: 受け口が成功を返しませんでした。");
  expect(report).toContain("合った文: 0/8。送信を試した文: 1。送っていない文: 7。");
  expect(report).toContain(`|不一致・未確認|${status}|`);
  expect(report).not.toContain(options.secret);
  expect(report).not.toContain(options.accessToken);
});
