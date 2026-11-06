import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { PROVIDER_CONTACT_FIXTURE as contactFixture } from "../fixtures/provider-contact";
import { seedAdmin } from "../src/core/testing";
import { sha256Hex } from "../src/core/password";
import { connectVerifiedSignIn } from "../src/core/sign-in";
import { CONTACT_WARD, type ContactBindings } from "../src/contact/store";
import { lineSecretNames, getLineAllowance, officerGroupId } from "../src/line/api";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { OPS_COOKIE } from "../src/ops/session";
import { cookieFrom, get, postForm, realApp, opsEnv, OPS_ID, OPS_PASSWORD } from "./helpers";

it("リンクを出し直してもLINE・メール・端末を保ち、メールの受付で戻し、提供側がグループを選んで集計済みの人数で配る", async () => {
  const owner = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const { ward, account, cookie } = owner;
  const root = `/${ward.slug}/admin`;
  const people = `${root}/settings/people`;
  const mail: Array<{ to: string; subject: string; text: string }> = [];
  const bindings: ContactBindings = { CONTACT_MAIL: { async send(message) { mail.push(message); } } };
  const secrets = lineSecretNames(ward.wardId);
  const runtime = Object.create(opsEnv, {
    CONTACT_MAIL: { value: bindings.CONTACT_MAIL },
    [secrets.accessTokenBinding]: { value: fixture.passphrase },
  }) as typeof env;
  const requests: string[] = [];
  let broadcast = 0;
  let unavailable = false;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
  const yesterday = new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10).replaceAll("-", "");
  const completedDay = new Date(Date.now() + 9 * 3600_000 - 2 * 86400_000).toISOString().slice(0, 10).replaceAll("-", "");
  // この流れのLINE呼び出しはすべて偽物。本物の住民には送らない。
  const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/insight/followers")) {
      const day = new URL(url).searchParams.get("date");
      expect(day).not.toBe(today);
      return Response.json(day === yesterday || unavailable ? { status: "unready", followers: null } : { status: "ready", followers: 3 });
    }
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/quota/consumption")) return Response.json({ totalUsage: 190 });
    if (url.endsWith("/summary")) return Response.json({ groupName: contactFixture.wardName });
    if (url.endsWith("/members/count")) return Response.json({ count: 4 });
    if (url.endsWith("/message/broadcast")) { broadcast++; return Response.json({}); }
    throw new Error("この試験で許可していないLINE呼び出しです");
  });
  try {
    expect((await connectVerifiedSignIn(env.DB, ward.wardId, { accountId: account.accountId }, { kind: "line", subject: ward.wardId })).ok).toBe(true);
    expect((await connectVerifiedSignIn(env.DB, ward.wardId, { accountId: account.accountId }, { kind: "email", email: contactFixture.reach })).ok).toBe(true);
    const created = await postForm(realApp, `${people}/accounts`, { name: contactFixture.newName }, cookie, runtime);
    expect(created.status).toBe(201);
    const invited = await env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND name = ?")
      .bind(ward.wardId, contactFixture.newName).first<{ account_id: string }>();
    if (!invited) throw new Error("足した役員がありません");
    // 同じ連絡先を二人へつなぐことも拒まない。
    expect((await connectVerifiedSignIn(env.DB, ward.wardId, { token: /\/invite\/([A-Za-z0-9_-]{43})/.exec(await created.text())![1]! }, { kind: "email", email: contactFixture.reach })).ok).toBe(true);
    const first = await postForm(realApp, `${people}/accounts/${account.accountId}/reset`, {}, cookie, runtime);
    expect(first.status).toBe(200);
    const oldToken = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await first.text())?.[1];
    if (!oldToken) throw new Error("入るためのリンクがありません");
    const second = await postForm(realApp, `${people}/accounts/${account.accountId}/reset`, {}, cookie, runtime);
    expect(second.status).toBe(200);
    expect((await get(realApp, `${root}/invite/${oldToken}`)).status).toBe(400);
    expect((await postForm(realApp, `${root}/login`, { loginId: account.loginId, password: account.password })).status).toBe(401);
    expect((await get(realApp, `${root}/`, cookie)).status).toBe(200);
    const methods = await env.DB.prepare("SELECT kind FROM sign_in_methods WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL ORDER BY kind")
      .bind(ward.wardId, account.accountId).all<{ kind: string }>();
    expect(methods.results.map((m) => m.kind)).toEqual(["email", "line"]);
    expect(requests).toHaveLength(0);
    expect((await postForm(realApp, `${root}/sign-in/line/remove`, {}, cookie)).status).toBe(404);

    expect((await postForm(realApp, "/contact", { ...contactFixture, kind: "access", reach: "" }, undefined, runtime)).status).toBe(400);
    const noMail = await postForm(realApp, "/contact", { ...contactFixture, kind: "access" }, undefined, opsEnv);
    expect(noMail.status).toBe(201);
    expect(await noMail.text()).toContain("この画面を閉じないでください");
    const contact = await postForm(realApp, "/contact", { ...contactFixture, kind: "access" }, undefined, runtime);
    expect(contact.status).toBe(201);
    expect(mail).toHaveLength(1);
    const threadPath = new URL(mail[0]!.text.trim().split("\n").at(-1)!).pathname;
    const token = threadPath.split("/").at(-1)!;
    const record = await env.DB.prepare("SELECT contact_id, receipt FROM provider_contacts WHERE ward_id = ? AND token_hash = ?")
      .bind(CONTACT_WARD, await sha256Hex(token)).first<{ contact_id: string; receipt: string }>();
    if (!record) throw new Error("受付がありません");
    expect(record.receipt).toMatch(/^\d{12}$/);
    expect((await get(realApp, `/contact/${record.receipt}`)).status).toBe(404);
    const opsLogin = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, runtime);
    const opsCookie = cookieFrom(opsLogin, OPS_COOKIE)!;
    const path = `/ops/contacts/${record.contact_id}`;
    const form = { wardId: ward.wardId, accountId: account.accountId, how: contactFixture.how };
    expect((await postForm(realApp, `${path}/invite`, { ...form, how: "" }, opsCookie, runtime)).status).toBe(400);
    expect((await postForm(realApp, `${path}/invite`, { ...form, accountId: other.account.accountId }, opsCookie, runtime)).status).toBe(400);
    expect((await postForm(realApp, `${path}/invite`, form, opsCookie, runtime)).status).toBe(200);
    const thread = await (await get(realApp, threadPath, undefined, runtime)).text();
    const invitation = /href="([^"]+\/admin\/invite\/[^"/]+)"/.exec(thread)?.[1];
    if (!invitation) throw new Error("本人を確かめたあとのリンクがありません");
    const stored = await env.DB.prepare("SELECT grant_secret, verified_how FROM provider_contacts WHERE ward_id = ? AND contact_id = ?")
      .bind(CONTACT_WARD, record.contact_id).first<{ grant_secret: string | null; verified_how: string }>();
    expect(stored).toEqual({ grant_secret: null, verified_how: contactFixture.how });
    const recovered = await postForm(realApp, `${new URL(invitation).pathname}/password`, {}, undefined, runtime);
    expect(recovered.status).toBe(200);
    expect((await postForm(realApp, `${new URL(invitation).pathname}/password`, {}, undefined, runtime)).status).toBe(400);
    expect((await get(realApp, `${root}/`, cookie, runtime)).status).toBe(200);

    const group = ward.wardId;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO line_channels (ward_id, destination, access_token_binding) VALUES (?, ?, ?)").bind(ward.wardId, ward.wardId, secrets.accessTokenBinding),
      env.DB.prepare("INSERT INTO line_group_notices (ward_id, group_id, first_joined_at) VALUES (?, ?, ?)").bind(ward.wardId, group, new Date().toISOString()),
    ]);
    expect((await postForm(realApp, `/ops/wards/${ward.slug}/officer-group`, { groupId: other.ward.wardId }, opsCookie, runtime)).status).toBe(400);
    expect((await postForm(realApp, `/ops/wards/${ward.slug}/officer-group`, { groupId: group }, opsCookie, runtime)).status).toBe(303);
    expect(await officerGroupId(runtime, ward.wardId)).toBe(group);
    expect(await officerGroupId(runtime, other.ward.wardId)).toBeNull();
    expect((await getLineAllowance(fixture.passphrase)).friends).toBe(3);
    expect(requests.some((url) => url.endsWith(`date=${completedDay}`))).toBe(true);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId });
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: fixture.draftTitle, scope: "public", basedOn: project.stateVersion,
      body: JSON.stringify({ text: fixture.publicAnnouncement, items: [] }),
    })).toBe(true);
    const draft = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!draft) throw new Error("下書きがありません");
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
      documentId: draft.document_id, versionId: draft.version_id, versionNo: String(draft.version_no), lineDelivery: "send", distribution: "",
    }, cookie, runtime)).status).toBe(303);
    expect(broadcast).toBe(1);
    unavailable = true;
    expect((await getLineAllowance(fixture.passphrase)).friends).toBeNull();
    expect(broadcast).toBe(1);
    const status = await env.DB.prepare("SELECT line_status FROM publication_records WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId).first<{ line_status: string }>();
    expect(status?.line_status).toBe("sent");
  } finally { fake.mockRestore(); }
});
