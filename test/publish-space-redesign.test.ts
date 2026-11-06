import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { createInvite } from "../src/space/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("資料も質問も仕事もない一年目に、案内を確認して配り、紙と班長の入口へ進み、下げて直せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const root = `/${ward.slug}/admin`;
  const path = `${root}/publish/${id}`;
  // 仕事を全部外した場合も、配る操作の結果に存在しない仕事を出さない。
  await env.DB.prepare("UPDATE project_map_tasks SET removed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind(new Date().toISOString(), ward.wardId, id).run();
  const state = await getProjectState(env.DB, ward.wardId, id);
  expect(state?.mapTasks).toHaveLength(0);
  expect(state?.questions).toHaveLength(0);
  const empty = await (await get(realApp, path, cookie)).text();
  expect(empty).toContain("配れる下書きはまだありません。");
  expect(empty).toContain(`/projects/${id}/draft/announcement`);
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "announcement", title: "案内", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: FIRST_SLICE.publicAnnouncement, items: [{ key: "place", content: FIRST_SLICE.previousPlace }] }),
  })).toBe(true);
  const draft = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!draft) throw new Error("架空の案内が保存されていません");
  const first = await get(realApp, `${path}/confirm?kind=announcement`, cookie);
  expect(first.status).toBe(200);
  const firstHtml = await first.text();
  expect(firstHtml).toContain("印刷して配れます");
  expect(firstHtml).toContain("次の内容で配ります");
  expect(firstHtml).toContain("LINEで送った知らせは取り消せません。");
  expect(firstHtml).toContain('class="compare-paper"');
  expect(firstHtml).toContain("切り取って班長か役員に渡します。");
  expect(firstHtml.split(FIRST_SLICE.publicAnnouncement)).toHaveLength(3);
  const savedPage = await (await get(realApp, `${root}/projects/${id}/draft/announcement?notice=saved`, cookie)).text();
  expect(savedPage).toContain(`/publish/${id}/confirm?kind=announcement`);
  await replaceRoster(env.DB, ward.wardId, [
    { district: FIRST_SLICE.district, household: FIRST_SLICE.firstHousehold },
    { district: FIRST_SLICE.district, household: FIRST_SLICE.secondHousehold },
  ], { household: 0, district: 1 });
  const confirmation = await (await get(realApp, `${path}/confirm?kind=announcement`, cookie)).text();
  expect(confirmation).toContain("2部を印刷できます");
  expect(confirmation).toContain('name="copies_0" min="1" value="2"');
  const sent = await postForm(realApp, `${path}/send`, {
    documentId: draft.document_id, versionId: draft.version_id, versionNo: String(draft.version_no),
    targetMode: "district", district: FIRST_SLICE.district, copies_0: "2", recipientScope: "member_households", lineDelivery: "send",
  }, cookie);
  expect(sent.status).toBe(303);
  const location = sent.headers.get("location");
  if (!location) throw new Error("配った結果への行き先がありません");
  const published = await (await get(realApp, location, cookie)).text();
  expect(published).toContain("案内を配りました");
  expect(published).toContain("公式LINEには送れませんでした");
  expect(published).toContain("区のページには載っています。紙も配れます。");
  expect(published).toContain("案内を印刷する");
  expect(published).toContain("班長への一枚を印刷する");
  expect(published).toContain("直して配り直す");
  expect(published).not.toContain("いま済みにしました");
  expect(published).not.toContain("段取りの「");
  const spaceAdmin = await postForm(realApp, `${root}/space/${id}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie);
  expect(spaceAdmin.status).toBe(200);
  const opened = await spaceAdmin.text();
  expect(opened).toContain("開いています");
  expect(opened).toContain(FIRST_SLICE.passphrase);
  expect(opened).toContain(`/print/${id}/${draft.document_id}/${draft.version_no}/leader`);
  const leaderToken = await createInvite(env.DB, ward.wardId, id, "leader", FIRST_SLICE.district, account.accountId, true);
  const entrance = await get(realApp, `/${ward.slug}/space/${id}/person/${leaderToken}`);
  const leaderCookie = cookieFrom(entrance, `space_${id}`);
  if (!leaderCookie) throw new Error("架空の班長が入れません");
  const spacePath = `/${ward.slug}/space/${id}`;
  const leader = await (await get(realApp, spacePath, leaderCookie)).text();
  expect(leader).toContain(`${FIRST_SLICE.district}の班長さんへ`);
  expect(leader).toContain("答えはまだありません。");
  expect(leader).toContain("回答票を撮って送る");
  expect(leader).not.toContain("協賛先");
  expect(leader).not.toContain("書き込んだ紙を撮って送る");
  const received = await (await get(realApp, `${spacePath}?sent=answer`, leaderCookie)).text();
  expect(received).toContain("残りがなければ、これで終わりです。");
  expect(received).toContain("紙は名前が読めないようにして捨ててかまいません。");
  const latest = await getProjectState(env.DB, ward.wardId, id);
  if (!latest) throw new Error("架空の行事がありません");
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "notice", title: "雨の変更", scope: "public", basedOn: latest.project.stateVersion,
    body: JSON.stringify({ text: FIRST_SLICE.rainAnnouncement, items: [{ key: "place", content: FIRST_SLICE.layoutPosition }] }),
  })).toBe(true);
  const rainConfirm = await (await get(realApp, `${path}/confirm?kind=notice`, cookie)).text();
  expect(rainConfirm).not.toContain('name="copies_0"');
  const notice = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'notice' ORDER BY v.version_no DESC LIMIT 1`)
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!notice) throw new Error("雨の変更がありません");
  const rain = await postForm(realApp, `${path}/send`, {
    documentId: notice.document_id, versionId: notice.version_id, versionNo: String(notice.version_no), lineDelivery: "skip",
  }, cookie);
  expect(rain.status).toBe(303);
  const rainLocation = rain.headers.get("location");
  if (!rainLocation) throw new Error("雨の変更を配った結果への行き先がありません");
  const rainSent = await (await get(realApp, rainLocation, cookie)).text();
  expect(rainSent).toContain("雨の変更を配りました");
  expect(rainSent).toContain("班長に電話して伝えてください。掲示も張り替えてください。");
  const publicPage = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
  expect(publicPage).toContain(FIRST_SLICE.publicAnnouncement);
  expect(publicPage).toContain(FIRST_SLICE.rainAnnouncement);
  const publication = new URL(location, "http://localhost").searchParams.get("done");
  if (!publication) throw new Error("配った記録がありません");
  const lower = await postForm(realApp, `${path}/lower/${publication}`, {}, cookie);
  expect(lower.status).toBe(303);
  const lowerLocation = lower.headers.get("location");
  if (!lowerLocation) throw new Error("下げた結果への行き先がありません");
  const lowered = await (await get(realApp, lowerLocation, cookie)).text();
  expect(lowered).toContain("下げました。配った記録は残ります。");
  expect(lowered).toContain("直して配り直す");
});
