import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { addAnswer, replaceRoster } from "../src/answers/api";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedWard, uniqueSlug } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { lineChannelCredentials, lineSecretNames } from "../src/line/api";
import { runDeletionCron } from "../src/ops/lifecycle";
import { OPS_COOKIE } from "../src/ops/session";
import { createProject } from "../src/project/api";
import { OPS_ID, OPS_PASSWORD, cookieFrom, get, opsEnv, postForm, realApp, withEnv } from "./helpers";

type RecordsFile = {
  wardId?: string;
  ward?: { ward_id: string };
  tables: Record<string, Record<string, unknown>[]>;
  objects?: { key: string; base64: string }[];
};

it("提供側が自治会を開いて入口を渡し、停止・再開・書き出しを経て、他の区を残して消せる", async () => {
  // VitestのD1/R2だけを使う。LINEの鍵も架空で、外部への通信は通さない。
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("提供側の一周の試験では外部へ通信しません"));
  try {
    const loggedIn = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv);
    expect(loggedIn.status).toBe(303);
    const ops = cookieFrom(loggedIn, OPS_COOKIE)!;
    expect(ops).toBeTruthy();
    const opening = await get(realApp, "/ops/", ops, opsEnv);
    expect(opening.status).toBe(200);
    expect(await opening.text()).toContain("新しい自治会を開く");

    const slug = uniqueSlug("provider");
    const destination = `fictional-${crypto.randomUUID()}`;
    const officialLineUrl = "https://example.invalid/fictional-line";
    const opened = await postForm(realApp, "/ops/wards", {
      name: "提供側の一周の区（架空）", slug, firstAccountName: "最初の役員（架空）",
      lineDestination: destination, officialLineUrl,
    }, ops, opsEnv);
    expect(opened.status).toBe(201);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const openedHtml = await opened.text();
    expect(openedHtml).toContain("自治会を開きました");
    const invitationUrl = /class="secret invite-link">([^<]+)</.exec(openedHtml)?.[1];
    expect(Boolean(invitationUrl)).toBe(true);
    const ward = await env.DB.prepare("SELECT ward_id FROM wards WHERE slug = ?").bind(slug).first<{ ward_id: string }>();
    const wardId = ward!.ward_id;
    const lineNames = lineSecretNames(wardId);
    expect(openedHtml).toContain(lineNames.channelSecretBinding);
    expect(openedHtml).toContain(lineNames.accessTokenBinding);

    // Workers secretsを登録する操作自体はこの試験の外。表示された参照先に架空の鍵を接続する。
    const bindings = withEnv({
      OPS_ID, OPS_PASSWORD,
      [lineNames.channelSecretBinding]: "fictional-channel-secret",
      [lineNames.accessTokenBinding]: "fictional-access-token",
    });
    expect(await lineChannelCredentials(bindings, wardId, destination)).toEqual({
      channelSecret: "fictional-channel-secret", accessToken: "fictional-access-token",
    });
    const opsRoot = `/ops/wards/${slug}`;
    const detail = await get(realApp, opsRoot, ops, bindings);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain(officialLineUrl);

    // 提供側が渡した一度だけの入口を、役員本人が開く。
    const invitePath = new URL(invitationUrl!).pathname;
    const invitation = await get(realApp, invitePath, undefined, bindings);
    expect(invitation.status).toBe(200);
    expect(await invitation.text()).toContain("IDとパスワードを作る");
    const entered = await postForm(realApp, `${invitePath}/password`, {}, undefined, bindings);
    expect(entered.status).toBe(200);
    const officer = cookieFrom(entered, "device")!;
    expect(officer).toBeTruthy();
    const admin = `/${slug}/admin`;
    expect((await get(realApp, `${admin}/`, officer, bindings)).status).toBe(200);

    // 引き渡しと消去で空の表を確かめるだけにならないよう、実際の保存口から記録を入れる。
    const account = await env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ?").bind(wardId).first<{ account_id: string }>();
    const project = await createProject(env.DB, wardId, { kind: "event", title: "架空の行事", year: 2026, accountId: account!.account_id });
    const entry = { household: "架空の世帯", district: "架空1班" };
    await replaceRoster(env.DB, wardId, [entry], { household: 0, district: 1 });
    const exemption = await postForm(realApp, `${admin}/rota/exemptions`, {
      household: JSON.stringify(entry), reason: "架空の免除の理由", starts_on: "2026-01-01", ends_on: "2026-12-31",
    }, officer, bindings);
    expect(exemption.status).toBe(303);
    expect(exemption.headers.get("location")).toContain("saved=1");
    const committee = await postForm(realApp, `${admin}/projects/${project.projectId}/committee`, {
      name: "実行委員（架空）", role: "会場係（架空）", contact: "committee@example.invalid",
    }, officer, bindings);
    expect(committee.status).toBe(303);
    expect(committee.headers.get("location")).toContain("saved=1");
    await addAnswer(env.DB, wardId, { ...entry, projectId: project.projectId, peopleCount: 2, source: "phone", accountId: account!.account_id });
    const originalText = "架空の行事の元の資料";
    const received = await receive(bindings, {
      wardId, projectId: project.projectId, via: "admin", accountId: account!.account_id,
      parts: [{ kind: "text", filename: "架空の資料.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(originalText) }],
    });
    expect(received.received).toHaveLength(1);
    const original = await env.DB.prepare("SELECT original_id, r2_path FROM originals WHERE ward_id = ? AND job_id = ?")
      .bind(wardId, received.jobId).first<{ original_id: string; r2_path: string }>();
    const bucket = new WardBucket(env.ORIGINALS, wardId);
    expect(await (await bucket.get(original!.r2_path))!.text()).toBe(originalText);
    const other = await seedWard(env.DB);
    const otherBucket = new WardBucket(env.ORIGINALS, other.wardId);
    await otherBucket.put(original!.r2_path, "ほかの区の架空の資料");
    await replaceRoster(env.DB, other.wardId, [entry], { household: 0, district: 1 });
    await writeDailyWardSnapshots(bindings, new Date("2026-11-06T00:00:00Z"));
    const snapshotPath = "snapshots/daily/2026-11-06.json";
    const snapshot = await (await bucket.get(snapshotPath))!.json<RecordsFile>();
    expect(snapshot.wardId).toBe(wardId);
    expect(snapshot.tables.project_answers).toContainEqual(expect.objectContaining({ household: entry.household, people_count: 2 }));
    expect(snapshot.tables.rota_exemptions).toContainEqual(expect.objectContaining({ reason: "架空の免除の理由" }));
    expect(snapshot.tables.project_rows).toContainEqual(expect.objectContaining({ table_key: "committee" }));

    const lifecycle = `${opsRoot}/lifecycle`;
    const stopped = await postForm(realApp, `${opsRoot}/state`, { active: "0" }, ops, bindings);
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe(`${lifecycle}?state=stopped`);
    expect(await (await get(realApp, stopped.headers.get("location")!, ops, bindings)).text()).toContain("自治会を止めました");
    expect((await get(realApp, `${admin}/`, officer, bindings)).status).toBe(503);
    expect((await get(realApp, `/${slug}/`, undefined, bindings)).status).toBe(200);
    const resumed = await postForm(realApp, `${opsRoot}/state`, { active: "1" }, ops, bindings);
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get("location")).toBe(`${lifecycle}?state=active`);
    const resumedPage = await (await get(realApp, resumed.headers.get("location")!, ops, bindings)).text();
    expect(resumedPage).toContain("自治会を再開しました");
    expect(resumedPage).toContain("自治会の記録を書き出す");
    expect((await get(realApp, `${admin}/`, officer, bindings)).status).toBe(200);

    const exported = await get(realApp, `${opsRoot}/export`, ops, bindings);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("cache-control")).toBe("no-store");
    expect(exported.headers.get("content-disposition")).toContain("attachment;");
    const records = await exported.json() as RecordsFile;
    expect(records.ward?.ward_id).toBe(wardId);
    expect(records.tables.originals).toContainEqual(expect.objectContaining({ original_id: original!.original_id }));
    expect(records.tables.project_answers).toContainEqual(expect.objectContaining({ household: entry.household, people_count: 2 }));
    expect(records.tables.rota_exemptions).toContainEqual(expect.objectContaining({ reason: "架空の免除の理由" }));
    expect(records.tables.project_rows).toContainEqual(expect.objectContaining({ table_key: "committee" }));
    expect(records.tables.accounts![0]).not.toHaveProperty("password_hash");
    expect(records.objects).toEqual([{ key: original!.r2_path, mediaType: "text/plain", base64: btoa(String.fromCharCode(...new TextEncoder().encode(originalText))) }]);

    const deletion = await postForm(realApp, `${opsRoot}/delete`, { confirm: "yes" }, ops, bindings);
    expect(deletion.status).toBe(303);
    expect(deletion.headers.get("location")).toBe(`${lifecycle}?queued=1`);
    expect(await (await get(realApp, deletion.headers.get("location")!, ops, bindings)).text()).toContain("消去の処理を受け付けました");
    expect((await get(realApp, `${admin}/`, officer, bindings)).status).toBe(503);
    for (let step = 0; step < 5; step++) {
      await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, bindings);
      const queue = await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ?").bind(wardId).first<{ state: string }>();
      expect(queue?.state).not.toBe("error");
      if (!queue) break;
    }
    for (const table of ["wards", "accounts", "line_channels", "ward_settings", "projects", "project_rows", "ward_roster_entries", "project_answers", "rota_exemptions", "jobs", "originals", "readings", "ops_deletion_queue"]) {
      const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ward_id = ?`).bind(wardId).first<{ n: number }>();
      expect(count!.n, table).toBe(0);
    }
    expect((await bucket.list("")).keys).toHaveLength(0);
    expect((await get(realApp, lifecycle, ops, bindings)).status).toBe(404);
    const mark = await env.DB.prepare("SELECT scope FROM ops_deletion_marks WHERE ward_id = ?").bind(wardId).all();
    expect(mark.results).toEqual([{ scope: "ward" }]);
    expect(await (await get(realApp, "/ops/deletions", ops, bindings)).text()).toContain("消去が済んだ記録");
    expect(await (await otherBucket.get(original!.r2_path))!.text()).toBe("ほかの区の架空の資料");
    expect(await otherBucket.head(snapshotPath)).not.toBeNull();
    expect(await env.DB.prepare("SELECT household, district FROM ward_roster_entries WHERE ward_id = ?").bind(other.wardId).all())
      .toMatchObject({ results: [entry] });
    expect(external).not.toHaveBeenCalled();
  } finally {
    external.mockRestore();
  }
});
