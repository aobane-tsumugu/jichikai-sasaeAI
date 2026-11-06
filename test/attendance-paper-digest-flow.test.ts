import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { fixOriginalIds } from "../src/ai/read";
import { READ_PACK_VERSION, type AnswerSheetReading } from "../src/ai/schema";
import { getAnswerTotals, listAnswers, getRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { runRead } from "../src/intake/pipeline";
import { lineAccessToken, lineSecretNames } from "../src/line/api";
import { sendOfficerDigest } from "../src/line/digest";
import { createLineIntakePorts, LINE_ANSWER_PACK } from "../src/line/intake";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { recordLineInquiry } from "../src/project/followup";
import { get, postForm, realApp, withEnv } from "./helpers";

it("初年度の出欠を紙とWebとLINEで受け、締切後は未回答を欠席と見せ、翌朝8時に役員だけへ一度知らせる", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-10-01T03:00:00Z"));
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const other = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, {
      kind: "event", title: fixture.nextYearTitle, year: fixture.nextYear, accountId: account.accountId,
    });
    const root = `/${ward.slug}/admin`;
    const answer = `/${ward.slug}/answer/${project.projectId}`;
    const answers = `${root}/answers/${project.projectId}`;
    const roster = `${root}/answers/roster`;
    const read = async (path: string) => {
      const response = await get(realApp, path, cookie);
      expect(response.status).toBe(200);
      return response.text();
    };
    expect(await read(answers)).toContain("まだ答えはありません");
    expect(await read(answers)).not.toContain("答えた0世帯");
    expect(await read(answers)).toContain("名簿を入れる");
    const form = await read(answer);
    expect(form).toContain(`${fixture.nextYearTitle}の出欠を教えてください`);
    expect([...form.matchAll(/<input\b[^>]*name="attend"[^>]*>/g)]).toHaveLength(2);
    expect(form).not.toMatch(/<input\b[^>]*name="attend"[^>]*checked/);
    expect(await read(`${answers}?view=hand`)).not.toMatch(/<input\b[^>]*name="attend"[^>]*checked/);
    const refused = await postForm(realApp, answer, {
      attend: "no", household: fixture.firstHousehold, district: "", children_count: "1", adults_count: "2", seniors_count: "3",
    });
    expect(refused.status).toBe(200);
    const receipt = await refused.text();
    expect(receipt).toContain("参加しない");
    expect(receipt).not.toContain("次は");
    expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toMatchObject([
      { peopleCount: 0, childrenCount: 0, adultsCount: 0, seniorsCount: 0 },
    ]);
    expect((await postForm(realApp, answer, {
      attend: "yes", household: fixture.secondHousehold, district: "", children_count: "1", adults_count: "2", seniors_count: "1",
    })).status).toBe(200);
    const before = await listAnswers(env.DB, ward.wardId, project.projectId);
    const attending = before.find((entry) => entry.peopleCount > 0)!;
    expect((await postForm(realApp, `${answers}/${attending.answerId}/edit`, {
      attend: "no", household: attending.household, district: "", adults_count: "4",
    }, cookie)).status).toBe(303);
    expect((await listAnswers(env.DB, ward.wardId, project.projectId)).find((entry) => entry.answerId === attending.answerId)?.peopleCount).toBe(0);
    expect((await postForm(realApp, `${answers}/phone`, {
      attend: "yes", household: fixture.phoneHousehold, district: "", children_count: "1", adults_count: "1", seniors_count: "1",
    }, cookie)).status).toBe(303);
    expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toMatchObject({ people: 3 });

    // 文書の題が「案内」でも、行事の名前で紙を出す。
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "案内", scope: "public", basedOn: 0,
      body: JSON.stringify({ text: fixture.publicAnnouncement, items: [
        { key: "date_time", content: fixture.eventDay }, { key: "place", content: fixture.previousPlace },
        { key: "helper_slots", content: fixture.helperTime }, { key: "public_contact", content: fixture.firstOfficer },
      ] }),
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'announcement' ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("配る案内がありません。");
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
    for (const kind of ["announcement", "answer"]) {
      const paper = await read(`${root}/print/${project.projectId}/${version.document_id}/${version.version_no}/${kind}`);
      expect(paper).toContain(`${fixture.nextYearTitle} 回答票`);
      expect(paper).toContain("□ 参加する");
      expect(paper).toContain("□ 参加しない");
      expect(paper).toContain("答えがないときは、欠席として数えます");
      expect(paper).toContain(fixture.helperTime);
    }

    // 写真の読み取りで不参加の印と人数が食い違っても、0人にそろえて同じ表へ入れる。
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
      parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) }],
    });
    const originalId = received.received[0]!.originalId;
    const reading = fixOriginalIds({ ...fixture.answerSheetReading, rows: [
      { ...fixture.answerSheetReading.rows[0]!, not_attending: true, original_id: originalId },
    ] }, [originalId]) as AnswerSheetReading;
    expect(reading.rows[0]).toMatchObject({ adults: 0, children: 0, seniors: 0 });
    expect(await runRead(env, ward.wardId, received.jobId!, { deps: {
      createClient: () => new Anthropic({ apiKey: fixture.passphrase }),
      readImpl: async () => ({ body: reading, packVersion: READ_PACK_VERSION.answer_sheet, model: "fixture",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }),
    } })).toBe("read");
    expect((await listAnswers(env.DB, ward.wardId, project.projectId)).find((entry) => entry.originalId === originalId)?.peopleCount).toBe(0);
    expect(await read(`${answers}?view=list`)).toContain("直して入れ直す");
    expect(READ_PACK_VERSION.answer_sheet).toBe("read-answer-sheet@7");
    expect(LINE_ANSWER_PACK.version).toBe("line-answer@2");
    const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
    for (const [index, text] of [`${fixture.secondHousehold}です。参加しません。`, `${fixture.phoneHousehold}です。不参加です。`].entries()) {
      const receivedText = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "line_direct",
        parts: [{ kind: "text", filename: fixture.rosterName, mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
      if (!ports.saveAnswerReply || !receivedText.jobId) throw new Error("LINEの答えを受け付けられません。");
      await ports.saveAnswerReply(ward.wardId, project.projectId, { eventId: crypto.randomUUID(), senderId: account.accountId,
        receivedAt: new Date().toISOString(), sourceType: "user", kind: "text", text }, receivedText.jobId);
      const lineAnswers = (await listAnswers(env.DB, ward.wardId, project.projectId)).filter((entry) => entry.source === "line");
      expect(lineAnswers).toHaveLength(index + 1);
      expect(lineAnswers.every((entry) => entry.peopleCount === 0)).toBe(true);
    }

    // 見出しを読めない名簿では、二つの項目を未選択から選ぶ。
    const rows = [["A", "B"], [fixture.firstHousehold, fixture.district], [fixture.rosterName, fixture.district]];
    const upload = new FormData();
    upload.set("part", new File([rows.map((row) => row.join(",")).join("\n")], "roster.csv", { type: "text/csv" }));
    const picked = await realApp.request(roster, { method: "POST", headers: { origin: "http://localhost", cookie }, body: upload }, env);
    expect(picked.status).toBe(200);
    expect(await picked.text()).toMatch(/name="household_column" required[^>]*><option value="" selected(?:="")? disabled/);
    const imported = await postForm(realApp, roster, { rows_json: JSON.stringify(rows), household_column: "0", district_column: "1" }, cookie);
    expect(imported.status).toBe(303);
    expect(await read(imported.headers.get("location")!)).toContain("2世帯、1班の名簿を入れました");
    expect(await getRoster(env.DB, ward.wardId)).toHaveLength(2);
    expect((await postForm(realApp, `${answers}/deadline`, { due_on: "2027-10-01" }, cookie)).status).toBe(303);
    vi.setSystemTime(new Date("2027-10-02T03:00:00Z"));
    const answerCount = (await listAnswers(env.DB, ward.wardId, project.projectId)).length;
    expect(await read(answers)).toContain("答えのない1世帯も欠席として数えています");
    const unansweredPaper = await read(`${answers}?view=unanswered&print=1`);
    expect(unansweredPaper).toContain('class="sheet"');
    expect(unansweredPaper).toContain(fixture.rosterName);
    expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(answerCount);
    expect(await listAnswers(env.DB, other.ward.wardId, project.projectId)).toHaveLength(0);
    expect((await get(realApp, `${other.ward.slug}/admin/answers/${project.projectId}`, other.cookie)).status).toBe(404);
    expect((await postForm(realApp, `${answers}/deadline`, { due_on: "2027-10-04" }, cookie)).status).toBe(303);
    expect(await read(`${root}/`)).toContain("知らせを待たずに、ときどき見てください");

    // Pushは全て偽物。残り通数、翌朝8時、重複実行、別の区、問い合わせ0件を同じ流れで確かめる。
    const secrets = lineSecretNames(ward.wardId);
    await env.DB.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, 'line.officer_group', ?)").bind(ward.wardId, `C${ward.wardId}`).run();
    const bindings = withEnv({ [secrets.accessTokenBinding]: fixture.passphrase });
    await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, ?, ?)`)
      .bind(ward.wardId, ward.wardId, secrets.channelSecretBinding, secrets.accessTokenBinding).run();
    expect(await lineAccessToken(bindings, ward.wardId)).toBe(fixture.passphrase);
    let used = 195;
    const pushes: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
      if (url.endsWith("/quota/consumption")) return Response.json({ totalUsage: used });
      if (url.endsWith("/members/count")) return Response.json({ count: 6 });
      if (url.endsWith("/message/push")) { pushes.push(String(init?.body)); return Response.json({ sentMessages: [{ id: account.accountId }] }); }
      throw new Error("想定しない外への要求です。");
    };
    const at = new Date("2027-10-01T23:00:00Z");
    await sendOfficerDigest(bindings, ward.wardId, ward.slug, at, fakeFetch);
    expect(pushes).toHaveLength(0);
    await recordLineInquiry(env.DB, ward.wardId, { eventId: crypto.randomUUID(), receivedAt: "2027-10-01T08:00:00Z",
      text: fixture.previousMaterial, sourceType: "user", sourceId: account.accountId, senderLabel: null });
    await sendOfficerDigest(bindings, ward.wardId, ward.slug, new Date("2027-10-01T22:55:00Z"), fakeFetch);
    expect(pushes).toHaveLength(0);
    await sendOfficerDigest(bindings, ward.wardId, ward.slug, at, fakeFetch);
    expect(pushes).toHaveLength(0);
    used = 194;
    await sendOfficerDigest(bindings, ward.wardId, ward.slug, at, fakeFetch);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`C${ward.wardId}`);
    expect(pushes[0]).toContain("届いた問い合わせは1件です");
    expect(pushes[0]).toContain(`${ward.slug}/admin/inquiries`);
    expect(pushes[0]).not.toContain(fixture.previousMaterial);
    await sendOfficerDigest(bindings, ward.wardId, ward.slug, at, fakeFetch);
    await sendOfficerDigest(bindings, other.ward.wardId, other.ward.slug, at, fakeFetch);
    await sendOfficerDigest(bindings, ward.wardId, ward.slug, new Date("2027-10-02T12:00:00Z"), fakeFetch);
    expect(pushes).toHaveLength(1);
    expect(await env.DB.prepare("SELECT recipients, inquiry_count FROM line_officer_digests WHERE ward_id = ? AND day = ?")
      .bind(ward.wardId, "2027-10-02").first()).toEqual({ recipients: 6, inquiry_count: 1 });
  } finally {
    vi.useRealTimers();
  }
});
