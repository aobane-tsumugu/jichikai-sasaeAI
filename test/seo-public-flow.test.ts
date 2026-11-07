import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { formatDateText } from "../src/core/time";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import type { DocumentKind, Scope } from "../src/project/model";
import { get, postForm, realApp, withEnv } from "./helpers";

it("二つの架空の区で、配った情報を転送でき、限定・下げたもの・停止した区を検索の一覧に出さない", async () => {
  const first = await seedAdmin(env.DB);
  const second = await seedAdmin(env.DB);
  const bindings = withEnv({ PUBLIC_BASE_URL: "https://example.test/" });
  const origin = "https://example.test";
  const root = `/${first.ward.slug}`;
  const project = await createProject(env.DB, first.ward.wardId, {
    kind: "event", title: fixture.nextYearTitle, year: fixture.nextYear, accountId: first.account.accountId,
  });
  const other = await createProject(env.DB, second.ward.wardId, {
    kind: "event", title: fixture.nextYearTitle, year: fixture.nextYear, accountId: second.account.accountId,
  });
  const restricted = await createProject(env.DB, first.ward.wardId, {
    kind: "event", title: fixture.dutyTitle, year: fixture.nextYear, accountId: first.account.accountId,
  });
  const draft = await createProject(env.DB, first.ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: fixture.nextYear, accountId: first.account.accountId,
  });
  const body = (text: string, place: string = fixture.previousPlace, day: string = fixture.eventDay) => JSON.stringify({ text, items: [
    { key: "date_time", content: day }, { key: "place", content: place },
  ] });
  const save = async (owner: typeof first, id: string, kind: DocumentKind, scope: Scope, content: string) => {
    expect(await saveDocument(env.DB, owner.ward.wardId, id, owner.account.accountId, {
      kind, scope, title: fixture.draftTitle, basedOn: 0, body: content,
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(owner.ward.wardId, id, kind).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("知らせる文書がありません。");
    return version;
  };
  const publish = async (owner: typeof first, id: string, kind: DocumentKind, content: string, scope: Scope = "public") => {
    const version = await save(owner, id, kind, scope, content);
    const response = await postForm(realApp, `/${owner.ward.slug}/admin/publish/${id}/${scope === "public" ? "send" : "space"}`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    }, owner.cookie);
    expect(response.status).toBe(303);
    return version;
  };
  const html = async (path: string, cookie?: string) => {
    const response = await get(realApp, path, cookie, bindings);
    expect(response.status).toBe(200);
    return response.text();
  };
  const head = (page: string) => page.split("</head>")[0]!;
  const sitemap = async () => {
    const response = await get(realApp, "/sitemap.xml", undefined, bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    return response.text();
  };
  const path = `${root}/p/${project.projectId}`;
  await publish(first, project.projectId, "announcement", body(fixture.publicAnnouncement));
  await publish(first, project.projectId, "recruitment", body(fixture.draftText));
  await publish(second, other.projectId, "announcement", body(fixture.rainAnnouncement, fixture.layoutSpot));
  await publish(first, restricted.projectId, "duty_roster", body(fixture.dutyText), "space");
  await save(first, restricted.projectId, "procedure", "staff", body(fixture.rosterName));
  await save(first, draft.projectId, "announcement", "public", body(fixture.reportText));

  // 配ったあとで下書きの本文・日時・場所と範囲を変えても、公開の説明は配った内容を保つ。
  await save(first, project.projectId, "announcement", "staff", body(fixture.rosterName, fixture.sponsorName, fixture.nextYearPeriod));
  let page = head(await html(`${path}/?s=${encodeURIComponent(fixture.firstHousehold)}`));
  expect(page).toContain(`${first.ward.name}｜${fixture.nextYearTitle}`);
  expect(page).toContain('name="description"');
  expect(page).toContain(formatDateText(fixture.eventDay));
  expect(page).toContain(fixture.previousPlace);
  for (const property of ["title", "description", "url", "type", "image"]) expect(page).toContain(`property="og:${property}"`);
  expect(page).toContain(`rel="canonical" href="${origin}${path}"`);
  expect(page).toContain(`property="og:url" content="${origin}${path}"`);
  expect(page).toContain('property="og:type" content="article"');
  for (const privateText of [fixture.rosterName, fixture.sponsorName, fixture.firstHousehold, fixture.layoutSpot]) expect(page).not.toContain(privateText);
  expect(head(await html(`${root}/`))).toContain(`rel="canonical" href="${origin}${root}/"`);
  expect(head(await html(`${root}/help/${project.projectId}`))).toContain("手伝いの募集");
  expect(head(await html(`${root}/answer/${project.projectId}`))).toContain('property="og:title"');
  expect((await get(realApp, `${root}/p/${other.projectId}`, undefined, bindings)).status).toBe(404);
  const received = await postForm(realApp, `${root}/help/${project.projectId}`, {
    helper_name: fixture.sheetHelper, helper_times: fixture.helperTime,
  });
  expect(received.status).toBe(200);
  expect(received.headers.get("x-robots-tag")).toBe("noindex");
  expect(received.headers.get("cache-control")).toBe("private, no-store");
  expect(head(await received.text())).not.toContain(fixture.sheetHelper);
  expect(head(await html(path))).not.toContain(fixture.sheetHelper);

  const robots = await (await get(realApp, "/robots.txt", undefined, bindings)).text();
  for (const rule of ["Disallow: /ops/", "Disallow: /contact/", "Disallow: /*/admin/", `Sitemap: ${origin}/sitemap.xml`]) expect(robots).toContain(rule);
  expect(head(await html(`${root}/admin/`, first.cookie))).toContain('name="robots" content="noindex"');
  // 未開設の入口も検索に出さず、開設したあとの合言葉の画面も確かめる。
  const unopenedSpace = await get(realApp, `${root}/space/${project.projectId}`, undefined, bindings);
  expect(unopenedSpace.status).toBe(403);
  expect(head(await unopenedSpace.text())).toContain('name="robots" content="noindex"');
  expect((await postForm(realApp, `${root}/admin/space/${project.projectId}/open`, {
    passphrase: fixture.passphrase,
  }, first.cookie)).status).toBe(200);
  expect(head(await html(`${root}/space/${project.projectId}`))).toContain('name="robots" content="noindex"');
  let map = await sitemap();
  for (const url of [`${origin}${root}/`, `${origin}${path}`, `${origin}/${second.ward.slug}/p/${other.projectId}`]) expect(map).toContain(`<loc>${url}</loc>`);
  for (const value of [restricted.projectId, draft.projectId, "/admin", "/space", "/ops", "/contact", fixture.firstHousehold, fixture.sheetHelper]) expect(map).not.toContain(value);

  // 知らせでは本文が正。転送用の説明で日時・場所を言い切らず、本文へ案内する。
  await publish(first, project.projectId, "notice", body(fixture.rainAnnouncement, fixture.layoutSpot));
  page = head(await html(path));
  expect(page).not.toContain(fixture.layoutSpot);
  expect(page).not.toContain(formatDateText(fixture.eventDay));
  expect(page).toContain('property="og:description"');
  expect(page).toContain(fixture.nextYearTitle);
  // 本文と項目が食い違っても、知らせの項目や以前の案内の場所を説明へ戻さない。
  await publish(first, project.projectId, "notice", body("架空の新会場へ変更します。", fixture.previousPlace));
  page = head(await html(path));
  expect(page).not.toContain(fixture.previousPlace);
  expect(page).not.toContain("架空の新会場");
  const lower = async (kind: DocumentKind) => {
    const record = await env.DB.prepare(`SELECT r.publication_id FROM publication_records r
      JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
      WHERE r.ward_id = ? AND r.project_id = ? AND d.kind = ? ORDER BY r.version_no DESC LIMIT 1`)
      .bind(first.ward.wardId, project.projectId, kind).first<{ publication_id: string }>();
    if (!record) throw new Error("下げる文書がありません。");
    expect((await postForm(realApp, `${root}/admin/publish/${project.projectId}/lower/${record.publication_id}`, {}, first.cookie)).status).toBe(303);
  };
  await lower("notice");
  page = head(await html(path));
  expect(page).toContain(fixture.previousPlace);
  expect(page).not.toContain(fixture.layoutSpot);

  // 直して配り直した最新の案内を下げても、古い案内を検索の一覧に戻さない。
  await publish(first, project.projectId, "announcement", body(fixture.rainAnnouncement, fixture.layoutSpot));
  await lower("announcement");
  await lower("recruitment");
  const lowered = await get(realApp, path, undefined, bindings);
  expect(lowered.headers.get("x-robots-tag")).toBe("noindex");
  page = await lowered.text();
  expect(page).not.toContain('name="description"');
  expect(page).not.toContain('property="og:description"');
  expect(await sitemap()).not.toContain(`<loc>${origin}${path}</loc>`);

  // 閉じた行事の公開の報告と活動は残る。手伝いの受付には転送用の説明を付けない。
  await publish(first, project.projectId, "report", body(fixture.reportText));
  expect((await postForm(realApp, `${root}/admin/close/${project.projectId}/finalize`, { body: fixture.reportText }, first.cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/admin/close/${project.projectId}/activity`, {
    action: "publish", introduction: fixture.reportText, membershipBurden: fixture.draftText, membershipBenefit: fixture.draftText,
  }, first.cookie)).status).toBe(303);
  expect(head(await html(path))).toContain("報告");
  expect(head(await html(`${root}/work/${project.projectId}`))).toContain("役員がしたこと");
  expect(head(await html(`${root}/help/${project.projectId}`))).not.toContain('property="og:description"');
  map = await sitemap();
  expect(map).toContain(`<loc>${origin}${path}</loc>`);
  expect(map).toContain(`<loc>${origin}${root}/work/${project.projectId}</loc>`);

  await env.DB.prepare("UPDATE wards SET is_active = 0 WHERE ward_id = ?").bind(second.ward.wardId).run();
  map = await sitemap();
  expect(map).not.toContain(`/${second.ward.slug}/`);
  expect(map).toContain(`<loc>${origin}${path}</loc>`);
  expect(head(await html(`/${second.ward.slug}/p/${other.projectId}`))).not.toContain('property="og:description"');
  expect((await get(realApp, "/no-such-ward/p/nothing", undefined, bindings)).status).toBe(404);

  const image = await get(realApp, "/share.png", undefined, bindings);
  expect(image.headers.get("content-type")).toBe("image/png");
  const bytes = new Uint8Array(await image.arrayBuffer());
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(16)).toBe(1200);
  expect(view.getUint32(20)).toBe(630);
});
