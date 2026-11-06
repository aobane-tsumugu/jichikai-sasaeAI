import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import { checkKindsDecision, checkKindsFacts, runKindsWalkthrough } from "../scripts/walkthrough-kinds";
import { setClientFactory } from "../src/ai/deps";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getProjectState } from "../src/project/api";
import { getRoster } from "../src/answers/api";
import { WardBucket } from "../src/core/storage";
import { realApp } from "./helpers";
import { prepareKindsRuntime } from "./kinds-fixture-runtime";
import { kindsMaterial } from "./fixtures/kinds";

it("総会の決定文は、画面が添えた曜日付きの日付だけを外して照合する", () => {
  const decision = kindsMaterial().decision;
  for (const suffix of ["", "（1月10日（土））", "（2月10日（火））"]) {
    expect(() => checkKindsDecision(` ${decision}${suffix} `, decision)).not.toThrow();
  }
  const withParentheses = "清掃用具（ほうきとちりとり）は共同で購入することに決めました";
  expect(() => checkKindsDecision(`${withParentheses}（1月10日（土））`, withParentheses)).not.toThrow();
});

it("総会の決定文に足された決定は、括弧の中でも照合で止める", () => {
  const decision = kindsMaterial().decision;
  for (const extra of ["（会費を増額することに決めました）", "。遊具の更新を可決しました。", "（AIの下書き）"]) {
    expect(() => checkKindsDecision(`${decision}${extra}（1月10日（土））`, decision)).toThrow("照合できない");
  }
});

// 複数の仕事の受付・MCP・配布・記録を順に通すため、この通し試験だけ上限を延ばす。
it("U51: 架空の役員会2回、当番の名簿変更と免除、市の依頼、総会への一年の決定を本体の経路で通す", async () => {
  const setup = await prepareKindsRuntime(env);
  const options = { base: "http://localhost", ward: setup.ward.slug, name: setup.account.name, password: setup.account.password };
  const reports: string[] = [], logs: string[] = [], cookieValues: string[] = [];
  const pending: Promise<void>[] = [];
  let posts = 0;
  const ports = {
    record: (report: string) => { reports.push(report); }, log: (line: string) => { logs.push(line); }, waitMs: 3000,
    sleep: async () => { await Promise.all(pending); },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(options.base);
      expect(url.pathname.startsWith(`/${setup.ward.slug}/`)).toBe(true);
      expect(init?.redirect).toBe("manual");
      if (init?.method === "POST") posts++;
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      if (/\/space\//.test(url.pathname) && !url.pathname.includes("/admin/")) expect(cookie).not.toContain("device=");
      if (/\/p\//.test(url.pathname) || url.pathname === `/${setup.ward.slug}/`) expect(cookie).toBe("");
      const ctx = createExecutionContext();
      const response = await realApp.fetch(new Request(url, init), env, ctx);
      for (const value of response.headers.getSetCookie()) cookieValues.push(value.split(";", 1)[0] ?? "");
      const done = waitOnExecutionContext(ctx); pending.push(done); await done;
      return response;
    }) as typeof fetch,
  };
  try {
    await expect(runKindsWalkthrough({ ...options, ward: "demoku" }, ports)).rejects.toThrow("demoku");
    expect(posts).toBe(0);
    const result = await runKindsWalkthrough(options, ports);
    expect(result.passed, reports.at(-1)).toBe(true);
    expect(reports).toHaveLength(4);
    expect(logs.filter(line => line.includes("通過"))).toHaveLength(4);
    expect(reports.at(-1)?.match(/\| 通過 \|/g)).toHaveLength(4);
    expect(reports.at(-1)).not.toContain("停止");
    for (const text of [...reports, ...logs]) for (const secret of [options.name, options.password, ...cookieValues]) expect(text).not.toContain(secret);
    expect(setup.activity().drafts).toBe(5);
    expect(setup.activity().connections).toBe(5);
    const source = kindsMaterial();
    for (const key of ["board1", "board2", "duty1", "city"]) {
      const state = await getProjectState(env.DB, setup.ward.wardId, result.projects[key]!);
      expect(state?.project.closedAt).toBeTruthy();
    }
    const first = await getProjectState(env.DB, setup.ward.wardId, result.projects.board1!);
    expect(first?.tables.decisions.map(row => row.data.what)).toEqual([source.decision]);
    expect(first?.tables.decisions[0]?.source.kind).toBe("person");
    expect(first?.questions.map(question => question.text)).toContain(source.pending);
    expect((await getRoster(env.DB, setup.ward.wardId)).map(entry => entry.household).sort()).toEqual([source.names.retained, source.names.exempt, source.names.arrived].sort());
    const duty = await getProjectState(env.DB, setup.ward.wardId, result.projects.duty2!);
    expect(duty?.tables.duties.filter(row => row.scope === "current").map(row => row.data.assignee)).toEqual([source.names.retained, "", source.names.arrived]);
    const original = await env.DB.prepare("SELECT r2_path FROM originals WHERE ward_id = ? AND filename = ?")
      .bind(setup.ward.wardId, `架空の当番の表_${result.projects.duty1}.txt`).first<{ r2_path: string }>();
    expect(original).toBeTruthy();
    const bucket = new WardBucket(env.ORIGINALS, setup.ward.wardId);
    expect(await (await bucket.get(original!.r2_path))?.text()).toBe(source.duty);
    for (const extra of ["会費を増額することに決めました。", "遊具の更新を可決しました。", "新しい倉庫を買います。"]) {
      expect(() => checkKindsFacts(source.decision + "。\n" + extra, [source.decision], [source.decision])).toThrow("照合できない");
    }
    // 外部の例外の内容を、記録や表示へ流さず停止する。
    const stopped: string[] = [];
    const failed = await runKindsWalkthrough(options, { ...ports, record: report => { stopped.push(report); },
      fetch: async () => { throw new Error(options.password + " 外部の例外本文"); },
    });
    expect(failed.passed).toBe(false);
    expect(stopped.at(-1)?.match(/\| 停止 \|/g)).toHaveLength(4);
    expect(stopped.at(-1)).not.toContain("外部の例外本文");
    expect(stopped.at(-1)).not.toContain(options.password);
  } finally {
    await Promise.allSettled(pending);
    setClientFactory(null); setPipelineDeps(null);
  }
}, 30_000);
