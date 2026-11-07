import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import { getAnswerTotals } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { createInvite } from "../src/space/api";
import { OPS_COOKIE } from "../src/ops/session";
import { cookieFrom, get, opsEnv, OPS_ID, OPS_PASSWORD, postForm, realApp } from "./helpers";

it("名簿のない一年目に一つの入口から紙を送り、公開の案内を残したまま自治会を止めて再開する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const root = `/${ward.slug}`;
  const admin = `${root}/admin`;
  const space = `${root}/space/${id}`;
  expect((await postForm(realApp, `${admin}/space/${id}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const setup = await (await get(realApp, `${admin}/space/${id}`, cookie)).text();
  expect(setup).toContain('class="qrbox"');
  expect(setup).toContain("配った班長への一枚も作り直しです");
  const token = await createInvite(env.DB, ward.wardId, id, "member", null, account.accountId);
  const entered = await get(realApp, `${space}/join/${token}`);
  const member = cookieFrom(entered, `space_${id}`);
  if (!member) throw new Error("実行委員の入口から入れませんでした");
  const joinedAt = entered.headers.get("location");
  if (!joinedAt) throw new Error("入口の案内がありません");
  expect(await (await get(realApp, joinedAt, member)).text()).toContain("いま使った入口は、もう使えません");
  const empty = await (await get(realApp, space, member)).text();
  expect(empty).toContain("手元の紙を撮って送る");
  expect(empty).toContain("返事はまだありません");
  expect(empty).not.toContain("0世帯のうち");
  expect(empty).not.toContain(`${space}?send=answer`);

  const client = new Anthropic({ apiKey: "fixture-only", fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { system: string };
    const body = request.system.includes("読み取りの作り方（回答票）") ? FIRST_SLICE.answerSheetReading : {
      document_kind: "answer_sheet", summary: FIRST_SLICE.publicAnnouncement,
      original_years: [{ original_id: "fixture-original", year: FIRST_SLICE.eventYear }],
      text_blocks: [{ original_id: "fixture-original", locator: "全体", text: FIRST_SLICE.firstHousehold }],
      fields: [{ name: "代表者のお名前", value: FIRST_SLICE.firstHousehold, confidence: "high", original_id: "fixture-original", locator: "名前の欄" }],
      tables: [{ name: "答え", original_id: "fixture-original", locator: "全体", columns: ["代表者のお名前"], rows: [{ cells: [FIRST_SLICE.firstHousehold], locator: "名前の欄", confidence: "high" }] }],
      decisions: [{ text: FIRST_SLICE.publicAnnouncement, confidence: "high", original_id: "fixture-original", locator: "全体" }],
      unreadable: FIRST_SLICE.answerSheetReading.unreadable,
    };
    return Response.json({ id: "fixture-message", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: JSON.stringify(body) }],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
    });
  } });
  setClientFactory(() => client);
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes)], FIRST_SLICE.answerSheetFilename, { type: "image/jpeg" }));
    const context = createExecutionContext();
    const sent = await realApp.request(`${space}/send`, { method: "POST", headers: { origin: "http://localhost", cookie: member }, body: form }, env, context);
    expect(sent.status).toBe(303);
    await waitOnExecutionContext(context);
    const receipt = await (await get(realApp, `${space}?sent=paper`, member)).text();
    expect(receipt).toContain("役員に届きました");
    expect(receipt).toContain("これで終わりです");
    expect((await getAnswerTotals(env.DB, ward.wardId, id)).people).toBeGreaterThan(0);
    const original = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id IN (SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND via = 'space')")
      .bind(ward.wardId, ward.wardId, id).first<{ original_id: string }>();
    if (!original) throw new Error("送った紙がありません");
    const file = `${space}/file/${original.original_id}`;
    const filePage = await (await get(realApp, file, member)).text();
    expect(filePage).toContain("実行委員のページへ戻る");
    expect(filePage).toContain("写真を大きく開く");
    const leaderToken = await createInvite(env.DB, ward.wardId, id, "leader", FIRST_SLICE.district, account.accountId, true);
    const leader = cookieFrom(await get(realApp, `${space}/person/${leaderToken}`), `space_${id}`);
    if (!leader) throw new Error("班長の入口から入れませんでした");
    expect((await get(realApp, file, leader)).status).toBe(403);
  } finally {
    setClientFactory(null);
  }

  // 文書の題が「案内」でも、区のページと出欠の入口が出る。
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "announcement", title: "案内", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: FIRST_SLICE.publicAnnouncement, items: [{ key: "place", content: FIRST_SLICE.previousPlace }] }),
  })).toBe(true);
  const draft = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1")
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!draft) throw new Error("案内がありません");
  expect((await postForm(realApp, `${admin}/publish/${id}/send`, {
    documentId: draft.document_id, versionId: draft.version_id, versionNo: String(draft.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const privacy = await (await get(realApp, `${root}/privacy`)).text();
  expect(privacy).toContain("AI事業者のAnthropicに委託します");
  expect(privacy).toContain("消してほしいとき");
  expect((await get(realApp, `${root}/line`)).status).toBe(200);

  const ops = cookieFrom(await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv), OPS_COOKIE);
  if (!ops) throw new Error("運用の画面に入れませんでした");
  const opsRoot = `/ops/wards/${ward.slug}`;
  const opsWard = await (await get(realApp, opsRoot, ops, opsEnv)).text();
  // 提供側の復旧は問い合わせの受付で、別の道で本人を確かめてから行う。
  expect(opsWard).toContain("問い合わせの受付で本人を確かめてからリンクを出します。");
  expect(opsWard).toContain('<a class="button" href="/ops/contacts">問い合わせを見る</a>');
  expect(opsWard).not.toContain("confirm(");
  const receivedJob = await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND via = 'space'")
    .bind(ward.wardId, id).first<{ job_id: string }>();
  if (!receivedJob) throw new Error("読み取りの記録がありません");
  await env.DB.prepare("UPDATE jobs SET status = 'failed', failure = 'too_large' WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, receivedJob.job_id).run();
  const queue = await (await get(realApp, `${opsRoot}/queue`, ops, opsEnv)).text();
  expect(queue).toContain(FIRST_SLICE.answerSheetFilename);
  expect(queue).toContain("資料を分けて送り直してもらってください");
  expect(queue).not.toContain(`/queue/${receivedJob.job_id}/retry`);
  expect((await postForm(realApp, `${opsRoot}/queue/${receivedJob.job_id}/retry`, {}, ops, opsEnv)).status).toBe(400);
  const budget = await postForm(realApp, `${opsRoot}/budget`, { monthlyLimit: "3.5" }, ops, opsEnv);
  expect(await budget.text()).toContain("予算を保存しました");
  const stopped = await postForm(realApp, `${opsRoot}/state`, { active: "0" }, ops, opsEnv);
  expect(stopped.status).toBe(303);
  const stoppedPage = await get(realApp, `${admin}/`, cookie);
  expect(stoppedPage.status).toBe(503);
  expect(await stoppedPage.text()).toContain('href="/contact"');
  const notice = await get(realApp, `${root}/p/${id}`);
  expect(notice.status).toBe(200);
  expect(await notice.text()).toContain(FIRST_SLICE.publicAnnouncement);
  expect((await postForm(realApp, `${opsRoot}/state`, { active: "1" }, ops, opsEnv)).status).toBe(303);
  expect((await get(realApp, `${admin}/`, cookie)).status).toBe(200);
});
