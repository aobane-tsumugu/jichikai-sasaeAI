import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import { checkMeetingMinutes, meetingMaterial, runMeetingWalkthrough } from "../scripts/walkthrough-meeting";
import { setClientFactory } from "../src/ai/deps";
import { listAnswers } from "../src/answers/api";
import { getProjectState } from "../src/project/api";
import { WardBucket } from "../src/core/storage";
import { setPipelineDeps } from "../src/intake/pipeline";
import { realApp } from "./helpers";
import { prepareMeetingRuntime } from "./meeting-fixture-runtime";

it("U42: 架空の総会を受付・AIの偽応答・公開・4通りのWebの返事・紙・電話・議事録・閉じた記録まで通す", async () => {
  const setup = await prepareMeetingRuntime(env);
  const options = { base: "http://localhost", ward: setup.ward.slug, name: setup.account.name, password: setup.account.password };
  const reports: string[] = [];
  const logs: string[] = [];
  let posts = 0;
  const pending: Promise<void>[] = [];
  const ports = {
    record: (report: string) => { reports.push(report); }, log: (line: string) => { logs.push(line); }, waitMs: 3000,
    sleep: async () => { await Promise.all(pending); },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(options.base);
      expect(url.pathname).toMatch(new RegExp(`^/${setup.ward.slug}/`));
      expect(init?.redirect).toBe("manual");
      if (init?.method === "POST") posts++;
      if (/\/answer\//.test(url.pathname) || /\/p\//.test(url.pathname)) expect(new Headers(init?.headers).has("cookie")).toBe(false);
      const ctx = createExecutionContext();
      const response = await realApp.fetch(new Request(url, init), env, ctx);
      const done = waitOnExecutionContext(ctx);
      pending.push(done);
      await done;
      return response;
    }) as typeof fetch,
  };
  try {
    await expect(runMeetingWalkthrough({ ...options, ward: "demoku" }, ports)).rejects.toThrow("demoku");
    expect(posts).toBe(0);
    const result = await runMeetingWalkthrough(options, ports);
    expect(result.passed, reports.at(-1)).toBe(true);
    expect(reports).toHaveLength(8);
    expect(logs.filter(line => line.includes("通過"))).toHaveLength(8);
    expect(reports.at(-1)).not.toContain("停止");
    for (const report of reports) for (const secret of [options.name, options.password]) expect(report).not.toContain(secret);
    expect(setup.activity().drafts).toBe(2);
    expect(setup.activity().calls).toBeGreaterThanOrEqual(10);
    const answers = await listAnswers(env.DB, setup.ward.wardId, result.project);
    expect(answers).toHaveLength(5);
    expect(answers.filter(a => a.source === "web")).toHaveLength(4);
    expect(answers.filter(a => a.meetingStatus === "proxy").map(a => a.proxyName).sort()).toEqual(["", "架空代理花子"]);
    expect((await getProjectState(env.DB, setup.ward.wardId, result.project))?.project.closedAt).toBeTruthy();
    const originals = await env.DB.prepare("SELECT o.r2_path FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND j.project_id = ?")
      .bind(setup.ward.wardId, result.project).all<{ r2_path: string }>();
    expect(originals.results).toHaveLength(2);
    const bucket = new WardBucket(env.ORIGINALS, setup.ward.wardId);
    const saved = await Promise.all(originals.results.map(async o => (await bucket.get(o.r2_path))?.text()));
    expect(saved).toContain(meetingMaterial().minutes);
    expect(saved).toContain(meetingMaterial().agenda);
    const source = meetingMaterial();
    expect(() => checkMeetingMinutes(source.minutes + "会費を増額することに決めました。", source)).toThrow("照合できない");
    // 本文が案内の記事から欠け、ほかの場所にあるだけなら通過にしない。
    const missingBodyReports: string[] = [];
    const missingBody = await runMeetingWalkthrough(options, { ...ports, record: report => { missingBodyReports.push(report); },
      fetch: async (input, init) => {
        const response = await ports.fetch(input, init);
        if (!new URL(String(input)).pathname.includes("/p/")) return response;
        const html = await response.text();
        expect(html).toContain(source.announcement);
        return new Response(html.replace(source.announcement, "") + `<aside>${source.announcement}</aside>`, {
          status: response.status, headers: response.headers,
        });
      },
    });
    expect(missingBody.passed).toBe(false);
    expect(missingBodyReports.at(-1)).toContain("公開のページに招集の本文がありません");
    // 入口が止まった場合の証拠も同じ主な流れで確かめる。
    const stoppedReports: string[] = [];
    const failed = await runMeetingWalkthrough(options, { ...ports, record: report => { stoppedReports.push(report); },
      fetch: async () => new Response("資格情報を本文に出さない", { status: 503 }),
    });
    expect(failed.passed).toBe(false);
    expect(stoppedReports.at(-1)?.match(/\| 停止 \|/g)).toHaveLength(8);
    expect(stoppedReports.at(-1)).not.toContain("資格情報を本文に出さない");
  } finally {
    await Promise.allSettled(pending);
    setClientFactory(null);
    setPipelineDeps(null);
  }
});
