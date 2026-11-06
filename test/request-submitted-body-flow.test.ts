import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { getEditableDocument, saveDocument } from "../src/project/actions";
import { listSubmittedItems, recordLineInquiry } from "../src/project/followup";
import { get, postForm, realApp, withEnv } from "./helpers";

it("共通の回答を提出時の本文として残して閉じ、発言者のIDがないグループへ返し、要望の仕事へ進む", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const runtime = withEnv({ LINE_CHANNEL_ACCESS_TOKEN: "fictional-u64-token" });
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, "fictional-u64-destination").run();
  const city = await createProject(env.DB, ward.wardId, { kind: "city_request", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const cityPath = `${root}/requests/city/${city.projectId}`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie, runtime);
    expect(response.status).toBe(200);
    return response.text();
  };
  const saveAnswer = async (projectId: string, text: string) => {
    const state = await getProjectState(env.DB, ward.wardId, projectId);
    if (!state) throw new Error("架空の仕事がありません");
    expect(await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
      kind: "report", title: fixture.draftTitle, scope: "staff", basedOn: state.project.stateVersion,
      body: JSON.stringify({ text, items: [{ key: "content", content: fixture.previousMaterial }] }),
    })).toBe(true);
    const document = await getEditableDocument(env.DB, ward.wardId, projectId, "report");
    if (!document?.versionId) throw new Error("共通の下書きがありません");
    return document.versionId;
  };
  const firstVersion = await saveAnswer(city.projectId, fixture.reportText);
  const cityHtml = await read(cityPath);
  expect(cityHtml).toContain(`href="${root}/projects/${city.projectId}/draft/report"`);
  expect(cityHtml).not.toContain('name="answerDraft"');
  expect(cityHtml).not.toContain("通知をもとに答えの下書きを作る");
  expect(cityHtml).toContain(`name="answerVersionId" value="${firstVersion}"`);
  const firstSubmission = crypto.randomUUID();
  const submitted = { operation: "save", submittedWhat: fixture.draftTitle, submittedTo: fixture.wardName, submittedOn: fixture.eventDay,
    answerVersionId: firstVersion, submissionId: firstSubmission };
  expect((await postForm(realApp, cityPath, submitted, cookie, runtime)).status).toBe(303);
  const nextVersion = await saveAnswer(city.projectId, fixture.rainAnnouncement);
  // 同じ画面の再送でも提出した本文を重ねて残さない。
  expect((await postForm(realApp, cityPath, submitted, cookie, runtime)).status).toBe(303);
  const firstRecord = await listSubmittedItems(env.DB, ward.wardId, city.projectId);
  expect(firstRecord).toHaveLength(1);
  expect(firstRecord[0]?.versionId).toBe(firstVersion);
  expect(firstRecord[0]?.body).toContain(fixture.reportText);
  expect(firstRecord[0]?.body).not.toContain(fixture.rainAnnouncement);
  // 出し直した本文も、前に出した本文と別に残る。
  expect((await postForm(realApp, cityPath, { ...submitted, answerVersionId: nextVersion, submissionId: crypto.randomUUID(), submittedOn: "2026-11-06" }, cookie, runtime)).status).toBe(303);
  expect(await listSubmittedItems(env.DB, ward.wardId, city.projectId)).toHaveLength(2);
  expect((await postForm(realApp, `${root}/close/${city.projectId}/finalize`, {}, cookie, runtime)).status).toBe(303);
  const archive = await read(`${root}/archive/${city.projectId}`);
  expect(archive).toContain("提出した本文");
  expect(archive).toContain(fixture.reportText);
  expect(archive).toContain(fixture.rainAnnouncement);
  expect(archive).toContain(`id="submission-${firstSubmission}"`);
  expect((await postForm(realApp, cityPath, submitted, cookie, runtime)).status).toBe(409);
  expect((await get(realApp, `/${other.ward.slug}/admin/archive/${city.projectId}`, other.cookie, runtime)).status).toBe(404);

  const groupId = "C-fictional-u64-group";
  await recordLineInquiry(env.DB, ward.wardId, { eventId: "fictional-u64-inquiry", receivedAt: "2026-11-06T01:00:00Z", text: fixture.previousMaterial,
    sourceType: "group", sourceId: groupId, userId: null, senderLabel: null });
  const row = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?")
    .bind(ward.wardId, "fictional-u64-inquiry").first<{ inquiry_id: string }>();
  if (!row) throw new Error("グループの問い合わせがありません");
  const inquiryPath = `${root}/inquiries/${row.inquiry_id}`;
  const calls: Array<{ to: string; messages: Array<{ text: string }> }> = [];
  const line: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/members/count")) return Response.json({ count: 3 });
    if (url.endsWith("/message/push")) {
      calls.push(JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> });
      return Response.json({ sentMessages: [{ id: "fictional-u64-sent" }] });
    }
    throw new Error(`試験にない外への呼び出し: ${url}`);
  };
  vi.stubGlobal("fetch", line);
  try {
    const inquiryHtml = await read(inquiryPath);
    expect(inquiryHtml).toContain("1か所に送る");
    expect(inquiryHtml).not.toContain("送り先が分からないため送れません");
    expect((await postForm(realApp, inquiryPath, { operation: "send", answer: fixture.publicDayText }, cookie, runtime)).status).toBe(303);
    expect(calls).toMatchObject([{ to: groupId, messages: [{ text: fixture.publicDayText }] }]);
    expect((await postForm(realApp, inquiryPath, { operation: "wish" }, cookie, runtime)).status).toBe(303);
    expect(await read(`${inquiryPath}?wish=1`)).toContain(`href="${inquiryPath}/request"`);
    const started = await postForm(realApp, `${inquiryPath}/request`, { projectId: "" }, cookie, runtime);
    expect(started.status).toBe(303);
    const requestPath = started.headers.get("location");
    if (!requestPath) throw new Error("要望の仕事へ進めません");
    const requestId = requestPath.split("/").at(-1)!;
    const state = await getProjectState(env.DB, ward.wardId, requestId);
    expect(state?.project.kind).toBe("request");
    expect(state?.items.find((item) => item.key === "content")?.current?.content).toBe(fixture.previousMaterial);
    expect(state?.mapTasks.some((task) => task.taskKey === "submit")).toBe(true);
    expect(await read(requestPath)).toContain(`href="${inquiryPath}"`);
    expect((await postForm(realApp, `${inquiryPath}/request`, { projectId: "" }, cookie, runtime)).headers.get("location")).toBe(requestPath);
    const answerVersion = await saveAnswer(requestId, fixture.publicAnnouncement);
    expect((await postForm(realApp, requestPath, { ...submitted, answerVersionId: answerVersion, submissionId: crypto.randomUUID() }, cookie, runtime)).status).toBe(303);
    expect((await postForm(realApp, `${root}/close/${requestId}/finalize`, {}, cookie, runtime)).status).toBe(303);
    expect(await read(`${root}/archive/${requestId}`)).toContain(fixture.publicAnnouncement);
    const existing = await createProject(env.DB, ward.wardId, { kind: "request", title: fixture.nextYearTitle, year: fixture.eventYear });
    expect((await postForm(realApp, `${inquiryPath}/request`, { projectId: existing.projectId }, cookie, runtime)).headers.get("location")).toBe(`${root}/requests/city/${existing.projectId}`);
    expect(await read(`${root}/requests/city/${existing.projectId}`)).toContain(fixture.previousMaterial);
    const foreign = await createProject(env.DB, other.ward.wardId, { kind: "request", title: fixture.draftTitle, year: fixture.eventYear });
    expect((await postForm(realApp, `${inquiryPath}/request`, { projectId: foreign.projectId }, cookie, runtime)).status).toBe(400);
  } finally {
    vi.unstubAllGlobals();
  }
});
