import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId } from "../src/core/ids";
import { seedAccount, seedSeat, seedWard } from "../src/core/testing";

describe("D1 の表", () => {
  it("全ての表が ward_id を持つ（全文索引の内部の表は除く）", async () => {
    const tables = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string; sql: string }>();
    const virtual = tables.results.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
    const missing: string[] = [];
    for (const t of tables.results) {
      if (virtual.some((v) => t.name.startsWith(`${v}_`)) || virtual.includes(t.name)) continue;
      const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('${t.name}')`).all<{ name: string }>();
      if (!cols.results.some((c) => c.name === "ward_id")) missing.push(t.name);
    }
    expect(tables.results.length).toBeGreaterThanOrEqual(5);
    expect(missing).toEqual([]);
  });

  it("他の区の席をアカウントに付けられない", async () => {
    const a = await seedWard(env.DB);
    const b = await seedWard(env.DB);
    const seatOfB = await seedSeat(env.DB, b.wardId, "会長");
    await expect(seedAccount(env.DB, a.wardId, "山田", { seatId: seatOfB })).rejects.toThrow();
  });

  it("他の区のアカウントに端末の記憶を付けられない", async () => {
    const a = await seedWard(env.DB);
    const b = await seedWard(env.DB);
    const accountOfB = await seedAccount(env.DB, b.wardId, "鈴木");
    await expect(
      env.DB.prepare(
        "INSERT INTO devices (device_id, ward_id, account_id, token_hash) VALUES (?, ?, ?, ?)",
      )
        .bind(newId(), a.wardId, accountOfB.accountId, newId())
        .run(),
    ).rejects.toThrow();
  });

  it("同じ区で同じ名前のアカウントは二つ作れず、別の区なら作れる", async () => {
    const a = await seedWard(env.DB);
    const b = await seedWard(env.DB);
    await seedAccount(env.DB, a.wardId, "田中 花子");
    await expect(seedAccount(env.DB, a.wardId, "田中花子")).rejects.toThrow();
    await expect(seedAccount(env.DB, b.wardId, "田中 花子")).resolves.toBeDefined();
  });
});
