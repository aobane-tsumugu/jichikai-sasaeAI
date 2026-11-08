import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { DEFAULT_ANSWER_LABELS, getAnswerLabels } from "../src/settings/answer-labels";
import { getDigestSettings } from "../src/settings/digest";
import { getPublicContact, getSquads } from "../src/settings/store";
import { postForm, realApp } from "./helpers";

const original = {
  contact: "試しの元の窓口", squads: "試しの元の班",
  answer_label_0: "試しの元の子ども", answer_label_1: "試しの元の大人", answer_label_2: "試しの元の高齢の方",
  digest_cutoff: "01:00", digest_send: "08:00", digest_event_days: "7", digest_due_days: "3",
};
const changed = {
  contact: "試しの新しい窓口", squads: "試しの新しい班",
  answer_label_0: "試しの新しい子ども", answer_label_1: "試しの新しい大人", answer_label_2: "試しの新しい高齢の方",
  digest_cutoff: "02:00", digest_send: "10:30", digest_event_days: "10", digest_due_days: "5",
};
const defaults = { answer_label_0: DEFAULT_ANSWER_LABELS[0], answer_label_1: DEFAULT_ANSWER_LABELS[1], answer_label_2: DEFAULT_ANSWER_LABELS[2] };

async function snapshot(wardId: string) {
  return {
    contact: await getPublicContact(env.DB, wardId), squads: await getSquads(env.DB, wardId),
    labels: await getAnswerLabels(env.DB, wardId), digest: await getDigestSettings(env.DB, wardId),
  };
}
async function fixture() {
  const setup = await seedAdmin(env.DB);
  const path = `/${setup.ward.slug}/admin/settings/info`;
  expect((await postForm(realApp, path, original, setup.cookie)).status).toBe(303);
  return { ...setup, path, saved: await snapshot(setup.ward.wardId) };
}
function expectFields(html: string, values: typeof original) {
  expect(html).toContain(values.contact);
  expect(html).toContain(values.squads);
  for (const name of ["answer_label_0", "answer_label_1", "answer_label_2", "digest_cutoff", "digest_send", "digest_event_days", "digest_due_days"] as const) {
    expect(html).toMatch(new RegExp(`<input\\b(?=[^>]*name="${name}")(?=[^>]*value="${values[name]}")[^>]*>`));
  }
}

it("聞き方を戻すときに時刻が空でも一部を保存せず、入力を残して直せる", async () => {
  const f = await fixture();
  const values = { ...changed, answer_labels_reset: "1", digest_send: "" };
  const invalid = await postForm(realApp, f.path, values, f.cookie);
  expect(invalid.status).toBe(400);
  expect(await snapshot(f.ward.wardId)).toEqual(f.saved);
  const html = await invalid.text();
  expectFields(html, { ...values, ...defaults });
  expect(invalid.headers.get("cache-control")).toBe("no-store");

  // エラー後のフォームに残った値を直し、ふつうの「保存する」で戻す内容を保存する。
  expect((await postForm(realApp, f.path, { ...changed, ...defaults }, f.cookie)).status).toBe(303);
  expect(await snapshot(f.ward.wardId)).toEqual({
    contact: changed.contact, squads: [changed.squads], labels: DEFAULT_ANSWER_LABELS,
    digest: { cutoff: changed.digest_cutoff, send: changed.digest_send, eventDays: 10, dueDays: 5 },
  });
});

it("人数の聞き方の入力漏れでもほかの設定を欄に残し、直すまで保存しない", async () => {
  const f = await fixture();
  const values = { ...changed, answer_label_1: "" };
  const invalid = await postForm(realApp, f.path, values, f.cookie);
  expect(invalid.status).toBe(400);
  const html = await invalid.text();
  expectFields(html, values);
  expect(html).toContain(`action="${f.path}"`);
  expect(await snapshot(f.ward.wardId)).toEqual(f.saved);

  expect((await postForm(realApp, f.path, changed, f.cookie)).status).toBe(303);
  expect(await snapshot(f.ward.wardId)).toEqual({
    contact: changed.contact, squads: [changed.squads], labels: [changed.answer_label_0, changed.answer_label_1, changed.answer_label_2],
    digest: { cutoff: changed.digest_cutoff, send: changed.digest_send, eventDays: 10, dueDays: 5 },
  });
});
