import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { applyChange, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("行事を開き、当番の行を保存しても、主な操作と記録を探す入口が一つに保たれる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const page = async (path: string) => {
    const response = await get(realApp, root + path, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };
  const primaryLabels = (html: string) => [...html.matchAll(/<(button|a)\b([^>]*)>([^<]*)<\/\1>/g)]
    .filter((match) => (match[1] === "button" || /class="[^"]*\bbutton\b/.test(match[2] ?? ""))
      && !/class="[^"]*\b(?:secondary|quiet)\b/.test(match[2] ?? ""))
    .map((match) => match[3]);

  const list = await page("/projects");
  expect(primaryLabels(list)).toEqual(["一年の予定に足して始める"]);
  expect(list).toMatch(/<form\b[^>]*>[\s\S]*?<div class="action-bar page-action"><button type="submit">一年の予定に足して始める<\/button><\/div>[\s\S]*?<\/form>/);
  const opened = await postForm(realApp, root + "/projects", {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: String(FIRST_SLICE.eventYear),
  }, cookie);
  expect(opened.status).toBe(303);
  const id = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1];
  if (!id) throw new Error("行事を開けませんでした");
  for (const slot of [FIRST_SLICE.helperTime, FIRST_SLICE.layoutSpot]) {
    expect((await applyChange(env.DB, ward.wardId, id, {
      kind: "row", table: "duties", data: { slot, task: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.sheetHelper },
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "screen-actions-flow@1",
    })).status).toBe("applied");
  }
  const path = `/projects/${id}/draft/duty_roster`;
  const draft = await page(path);
  expect(primaryLabels(draft)).toEqual(["保存して知らせる内容を見る"]);
  expect(draft).toContain('<button type="submit" class="secondary">この行を保存する</button>');
  expect(draft).toContain('form="draft-form" name="after" value="confirm"');
  const state = await getProjectState(env.DB, ward.wardId, id);
  const row = state?.tables.duties[0];
  if (!row) throw new Error("当番の行がありません");
  const saved = await postForm(realApp, `${root}/projects/${id}/draft/duty-row/${row.rowId}`, {
    slot: String(row.data.slot), task: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.phoneHelper, attendance: "no_change",
  }, cookie);
  expect(saved.status).toBe(303);
  const after = await page(path + "?notice=saved");
  expect(primaryLabels(after)).toEqual(["保存して知らせる内容を見る"]);
  expect(after).toContain(`value="${FIRST_SLICE.phoneHelper}"`);

  const search = await page("/archive/search");
  expect(primaryLabels(search)).toEqual(["探す"]);
  expect(search).toMatch(/<form\b[^>]*action="[^"]*\/archive\/search"[^>]*>[\s\S]*?<p class="action-bar page-action"><button>探す<\/button><\/p>\s*<\/form>/);
  expect(primaryLabels(await page("/settings/deletion"))).toEqual(["この名前で探す"]);
  expect(primaryLabels(await page("/settings/templates"))).toEqual(["足す"]);
});
