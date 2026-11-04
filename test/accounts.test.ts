import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAccount, seedDeviceCookie, seedSeat, seedWard } from "../src/core/testing";
import {
  addAccount,
  addSeat,
  listAccounts,
  listSeats,
  lockOutDevices,
  removeAccount,
  removeSeat,
  resetPassword,
  setAccountSeat,
} from "../src/settings/accounts";

const db = env.DB;

describe("席", () => {
  it("足せて、同じ名前は二つ作れず、別の区なら作れる", async () => {
    const a = await seedWard(db);
    const b = await seedWard(db);
    expect((await addSeat(db, a.wardId, "会長")).ok).toBe(true);
    expect((await addSeat(db, a.wardId, " 会長 ")).ok).toBe(false);
    expect((await addSeat(db, b.wardId, "会長")).ok).toBe(true);
    expect((await addSeat(db, a.wardId, "")).ok).toBe(false);
    expect((await listSeats(db, a.wardId)).map((s) => s.title)).toEqual(["会長"]);
  });

  it("並びは足した順。外した席は一覧から消え、その席にいた人は席なしになる", async () => {
    const ward = await seedWard(db);
    const chair = await addSeat(db, ward.wardId, "会長");
    const clerk = await addSeat(db, ward.wardId, "書記");
    if (!chair.ok || !clerk.ok) throw new Error("席を足せませんでした");
    const person = await addAccount(db, ward.wardId, { name: "山田", seatId: chair.seatId });
    if (!person.ok) throw new Error("アカウントを足せませんでした");

    expect((await listSeats(db, ward.wardId)).map((s) => s.title)).toEqual(["会長", "書記"]);
    expect((await removeSeat(db, ward.wardId, chair.seatId)).ok).toBe(true);
    expect((await listSeats(db, ward.wardId)).map((s) => s.title)).toEqual(["書記"]);
    const accounts = await listAccounts(db, ward.wardId);
    expect(accounts[0]).toMatchObject({ name: "山田", seatId: null, seatTitle: null });
    // 外した席の名前はまた使える
    expect((await addSeat(db, ward.wardId, "会長")).ok).toBe(true);
    // 他の区の席は外せない
    const other = await seedWard(db);
    expect((await removeSeat(db, other.wardId, clerk.seatId)).ok).toBe(false);
  });
});

describe("アカウント", () => {
  it("足すとパスワードが一度返り、同じ名前は重複できない", async () => {
    const ward = await seedWard(db);
    const first = await addAccount(db, ward.wardId, { name: "田中 花子" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.password).toMatch(/^[a-z0-9]{6}(-[a-z0-9]{6}){3}$/);
    expect((await addAccount(db, ward.wardId, { name: "田中花子" })).ok).toBe(false);
    expect((await addAccount(db, ward.wardId, { name: "x".repeat(41) })).ok).toBe(false);
    expect((await addAccount(db, ward.wardId, { name: "改\u0007行" })).ok).toBe(false);
    const other = await seedWard(db);
    expect((await addAccount(db, other.wardId, { name: "田中花子" })).ok).toBe(true);
  });

  it("存在しない席や他の区の席は付けられない", async () => {
    const a = await seedWard(db);
    const b = await seedWard(db);
    const seatOfB = await seedSeat(db, b.wardId, "会計");
    expect((await addAccount(db, a.wardId, { name: "甲", seatId: seatOfB })).ok).toBe(false);
    const person = await seedAccount(db, a.wardId, "乙");
    expect((await setAccountSeat(db, a.wardId, person.accountId, seatOfB)).ok).toBe(false);
    const seatOfA = await seedSeat(db, a.wardId, "書記");
    expect((await setAccountSeat(db, a.wardId, person.accountId, seatOfA)).ok).toBe(true);
    expect((await setAccountSeat(db, a.wardId, person.accountId, null)).ok).toBe(true);
    // 他の区のアカウントは付け替えられない
    expect((await setAccountSeat(db, b.wardId, person.accountId, seatOfB)).ok).toBe(false);
  });

  it("最後の一人は外せず、二人目がいれば外せる。外すと端末の記憶も消える", async () => {
    const ward = await seedWard(db);
    const one = await seedAccount(db, ward.wardId, "一人目");
    await seedDeviceCookie(db, ward.wardId, one.accountId);

    const refused = await removeAccount(db, ward.wardId, one.accountId, null);
    expect(refused.ok).toBe(false);
    expect((await listAccounts(db, ward.wardId)).length).toBe(1);

    const two = await seedAccount(db, ward.wardId, "二人目");
    expect((await removeAccount(db, ward.wardId, one.accountId, two.accountId)).ok).toBe(true);
    const left = await listAccounts(db, ward.wardId);
    expect(left.map((a) => a.name)).toEqual(["二人目"]);
    const devices = await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE ward_id = ? AND account_id = ?")
      .bind(ward.wardId, one.accountId)
      .first<{ n: number }>();
    expect(devices?.n).toBe(0);
    // 行は残り、誰が外したかが分かる
    const row = await db.prepare("SELECT removed_at, removed_by_account_id FROM accounts WHERE account_id = ?")
      .bind(one.accountId)
      .first<{ removed_at: string; removed_by_account_id: string }>();
    expect(row?.removed_at).toBeTruthy();
    expect(row?.removed_by_account_id).toBe(two.accountId);
    // 外した名前はまた使える。もう一度外そうとしても失敗する
    expect((await addAccount(db, ward.wardId, { name: "一人目" })).ok).toBe(true);
    expect((await removeAccount(db, ward.wardId, one.accountId, null)).ok).toBe(false);
  });

  it("他の区のアカウントは外せない", async () => {
    const a = await seedWard(db);
    const b = await seedWard(db);
    await seedAccount(db, a.wardId, "A の一人目");
    const bOne = await seedAccount(db, b.wardId, "B の一人目");
    await seedAccount(db, b.wardId, "B の二人目");
    expect((await removeAccount(db, a.wardId, bOne.accountId, null)).ok).toBe(false);
    expect((await listAccounts(db, b.wardId)).length).toBe(2);
  });

  it("初期化: 新しいパスワードを渡し、古いパスワードと他の端末は使えなくなる", async () => {
    const ward = await seedWard(db);
    const person = await seedAccount(db, ward.wardId, "初期化する人");
    const keep = await seedDeviceCookie(db, ward.wardId, person.accountId);
    await seedDeviceCookie(db, ward.wardId, person.accountId);
    const keepId = (
      await db.prepare("SELECT device_id FROM devices WHERE ward_id = ? ORDER BY created_at LIMIT 1")
        .bind(ward.wardId)
        .first<{ device_id: string }>()
    )?.device_id;
    expect(keep).toContain("device=");

    const reset = await resetPassword(db, ward.wardId, person.accountId, keepId);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.password).not.toBe(person.password);
    const accounts = await listAccounts(db, ward.wardId);
    expect(accounts[0]?.devices.map((d) => d.deviceId)).toEqual([keepId]);

    const missing = await resetPassword(db, ward.wardId, "no-such-account");
    expect(missing.ok).toBe(false);
    const other = await seedWard(db);
    expect((await resetPassword(db, other.wardId, person.accountId)).ok).toBe(false);
  });

  it("端末の締め出し: 一台だけ、またはそのアカウントの全部", async () => {
    const ward = await seedWard(db);
    const person = await seedAccount(db, ward.wardId, "端末の人");
    const bystander = await seedAccount(db, ward.wardId, "別の人");
    await seedDeviceCookie(db, ward.wardId, person.accountId);
    await seedDeviceCookie(db, ward.wardId, person.accountId);
    await seedDeviceCookie(db, ward.wardId, bystander.accountId);

    const before = (await listAccounts(db, ward.wardId)).find((a) => a.name === "端末の人");
    expect(before?.devices.length).toBe(2);
    const one = await lockOutDevices(db, ward.wardId, person.accountId, before?.devices[0]?.deviceId);
    expect(one).toEqual({ ok: true, count: 1 });
    const all = await lockOutDevices(db, ward.wardId, person.accountId);
    expect(all).toEqual({ ok: true, count: 1 });
    const after = await listAccounts(db, ward.wardId);
    expect(after.find((a) => a.name === "端末の人")?.devices.length).toBe(0);
    expect(after.find((a) => a.name === "別の人")?.devices.length).toBe(1);
    // 他の区からは消せない
    const other = await seedWard(db);
    expect(await lockOutDevices(db, other.wardId, bystander.accountId)).toEqual({ ok: true, count: 0 });
  });
});
