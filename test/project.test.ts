import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId } from "../src/core/ids";
import { seedAccount, seedWard } from "../src/core/testing";
import {
  addQuestion,
  applyChange,
  createProject,
  getProjectState,
  listOpenProjects,
  type ApplyResult,
  type ChangeInput,
  type Source,
} from "../src/project/api";

const db = env.DB;

async function setup(kind: "event" | "board_meeting" = "event") {
  const ward = await seedWard(db);
  const account = await seedAccount(db, ward.wardId, "試験の書記（架空）");
  const project = await createProject(db, ward.wardId, {
    kind,
    title: "秋の収穫祭（架空）",
    year: 2026,
    eventDay: "2026-10-24",
    accountId: account.accountId,
  });
  return { ward, account, project };
}

const person = (accountId: string): Source => ({ kind: "person", accountId });
const paper = (originalId: string, extra: Partial<Source> = {}): Source => ({
  kind: "original",
  ref: originalId,
  locator: "p1 3行目",
  year: 2026,
  ...extra,
});

function item(source: Source, value: string, extra: Partial<Extract<ChangeInput, { kind: "item" }>> = {}): ChangeInput {
  return { kind: "item", itemKey: "date_time", value, source, confidence: "high", packVersion: "tsunagu-1", ...extra };
}

function expectStatus<S extends ApplyResult["status"]>(result: ApplyResult, status: S): Extract<ApplyResult, { status: S }> {
  expect(result.status).toBe(status);
  return result as Extract<ApplyResult, { status: S }>;
}

async function insertDocument(wardId: string, projectId: string, kind: string) {
  const documentId = newId();
  await db
    .prepare("INSERT INTO documents (document_id, ward_id, project_id, kind, title, scope) VALUES (?, ?, ?, ?, ?, 'public')")
    .bind(documentId, wardId, projectId, kind, `${kind}（架空）`)
    .run();
  return documentId;
}

describe("行事を開く", () => {
  it("種類ごとのやることの型と行事の日を置き、開いている一覧に出る", async () => {
    const { ward, project } = await setup();
    expect(project.deadlines.event_day).toBe("2026-10-24");
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.mapTasks.map((t) => t.taskKey)).toEqual([
      "committee", "venue", "sponsors", "announcement", "answers", "duty_roster", "day", "report",
    ]);
    // 行事の日（10 月 24 日）の当日の仕事は、その日に置かれる
    expect(state?.mapTasks.find((t) => t.taskKey === "day")?.periodStart).toBe("2026-10-24");
    expect(state?.items.map((i) => i.key)).toContain("rain_plan");
    const open = await listOpenProjects(db, ward.wardId);
    expect(open.map((p) => p.projectId)).toContain(project.projectId);
  });

  it("終わったものは開いている一覧に出ない", async () => {
    const { ward, project } = await setup();
    await db.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind("2026-11-01T00:00:00.000Z", ward.wardId, project.projectId).run();
    expect((await listOpenProjects(db, ward.wardId)).map((p) => p.projectId)).not.toContain(project.projectId);
  });

  it("別の区からは見えず、書き込めない", async () => {
    const a = await setup();
    const b = await seedWard(db);
    expect(await listOpenProjects(db, b.wardId)).toEqual([]);
    expect(await getProjectState(db, b.wardId, a.project.projectId)).toBeNull();
    const result = await applyChange(db, b.wardId, a.project.projectId, item(person(a.account.accountId), "10月24日"));
    expect(result).toEqual({ status: "rejected", reason: "no_project" });
  });

  it("行事にない項目しか持たない種類では、その項目の差分を捨てる", async () => {
    const { ward, account, project } = await setup("board_meeting");
    const result = await applyChange(
      db, ward.wardId, project.projectId,
      { kind: "item", itemKey: "belongings", value: "筆記用具", source: person(account.accountId), confidence: "high", packVersion: "p1" },
    );
    expectStatus(result, "dropped");
  });
});

describe("出どころの検査", () => {
  it("出どころのない差分は捨て、捨てたことが質問の一覧に出る", async () => {
    const { ward, project } = await setup();
    const bad = { kind: "item", itemKey: "date_time", value: "10月24日", confidence: "high", packVersion: "p1" } as unknown as ChangeInput;
    const result = expectStatus(await applyChange(db, ward.wardId, project.projectId, bad), "dropped");
    expect(result.reason).toContain("出どころ");
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.items.find((i) => i.key === "date_time")?.current).toBeNull();
    const discarded = state?.questions.filter((q) => q.kind === "discarded") ?? [];
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.text).toContain("取り込めませんでした");
    // 同じ物をもう一度送っても、問いは増えない
    const again = await applyChange(db, ward.wardId, project.projectId, bad);
    expect(again).toMatchObject({ status: "dropped", duplicate: true });
    expect((await getProjectState(db, ward.wardId, project.projectId))?.questions.filter((q) => q.kind === "discarded")).toHaveLength(1);
  });

  it("型の外の差分（知らない種類、空）も例外にせず捨て、質問の一覧に出る", async () => {
    const { ward, account, project } = await setup();
    const unknownKind = { kind: "foo", source: person(account.accountId), confidence: "high", packVersion: "p1" } as unknown as ChangeInput;
    expectStatus(await applyChange(db, ward.wardId, project.projectId, unknownKind), "dropped");
    expectStatus(await applyChange(db, ward.wardId, project.projectId, null as unknown as ChangeInput), "dropped");
    expectStatus(await applyChange(db, ward.wardId, project.projectId, {} as unknown as ChangeInput), "dropped");
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.questions.filter((q) => q.kind === "discarded")).toHaveLength(3);
    const kinds = await db
      .prepare("SELECT DISTINCT kind FROM project_changes WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId)
      .all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(["unknown"]);
  });

  it("実在しない元の資料の差分は捨てる（確かめる口がfalseを返す）", async () => {
    const { ward, project } = await setup();
    const result = await applyChange(db, ward.wardId, project.projectId, item(paper("no-such-original"), "10月24日"), {
      verifyOriginal: async () => false,
    });
    expect(expectStatus(result, "dropped").reason).toContain("元の資料が見つかりません");
  });

  it("人の入力は、同じ区のアカウントでなければ捨てる", async () => {
    const { ward, project } = await setup();
    const other = await seedWard(db);
    const stranger = await seedAccount(db, other.wardId, "別の区の人（架空）");
    const result = await applyChange(db, ward.wardId, project.projectId, item(person(stranger.accountId), "10月24日"));
    expectStatus(result, "dropped");
  });

  it("AIの下書きは、参考にした年がなければ捨てる", async () => {
    const { ward, project } = await setup();
    const result = await applyChange(db, ward.wardId, project.projectId, item({ kind: "ai_proposal" }, "10月24日"));
    expectStatus(result, "dropped");
  });

  it("捨てた差分は、直して送り直せば入る", async () => {
    const { ward, project } = await setup();
    const first = await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月24日"), { verifyOriginal: async () => false });
    expectStatus(first, "dropped");
    const second = await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月24日"), { verifyOriginal: async () => true });
    expectStatus(second, "applied");
  });
});

describe("重複を弾く印", () => {
  it("同じ差分の二度目は、保存した結果をそのまま返す", async () => {
    const { ward, project } = await setup();
    const change = item(paper("o-1"), "10月24日11時");
    const first = expectStatus(await applyChange(db, ward.wardId, project.projectId, change), "applied");
    expect(first.duplicate).toBe(false);
    const second = await applyChange(db, ward.wardId, project.projectId, change);
    expect(second).toMatchObject({ status: "applied", duplicate: true, changeId: first.changeId, stateVersion: first.stateVersion });
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.project.stateVersion).toBe(first.stateVersion);
  });

  it("同じ印で中身が違えば受けない", async () => {
    const { ward, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月24日11時"));
    const result = await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月25日11時"));
    expect(result).toEqual({ status: "rejected", reason: "key_reused" });
  });

  it("同じ元の資料から別の項目を書くのは通る", async () => {
    const { ward, project } = await setup();
    expectStatus(await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月24日")), "applied");
    expectStatus(
      await applyChange(db, ward.wardId, project.projectId, { ...item(paper("o-1"), "公民館"), itemKey: "place" } as ChangeInput),
      "applied",
    );
  });

  it("包みの版が違えば別の印になる（同じ中身なら同じものでした）", async () => {
    const { ward, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月24日"));
    const result = await applyChange(db, ward.wardId, project.projectId, item(paper("o-1"), "10月24日", { packVersion: "tsunagu-2" }));
    expectStatus(result, "same");
  });

  it("終わったものには入れない", async () => {
    const { ward, account, project } = await setup();
    await db.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind("2026-11-01T00:00:00.000Z", ward.wardId, project.projectId).run();
    expect(await applyChange(db, ward.wardId, project.projectId, item(person(account.accountId), "10月24日"))).toEqual({
      status: "rejected",
      reason: "closed",
    });
  });
});

describe("今年の中身と参考の中身", () => {
  it("去年の資料の中身は参考（年ごと）に入り、今年には入らない", async () => {
    const { ward, project } = await setup();
    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, item(paper("o-last", { year: 2025 }), "10月25日")),
      "applied",
    );
    expect(result.stateVersion).toBe(1);
    const date = (await getProjectState(db, ward.wardId, project.projectId))?.items.find((i) => i.key === "date_time");
    expect(date?.current).toBeNull();
    expect(date?.references).toHaveLength(1);
    expect(date?.references[0]).toMatchObject({
      content: "10月25日",
      scope: "reference",
      refYear: 2025,
      confidence: "high",
      source: { kind: "original", ref: "o-last", locator: "p1 3行目", year: 2025 },
    });
  });

  it("年不明の資料は参考に留まる", async () => {
    const { ward, project } = await setup();
    const unknownYear: Source = { kind: "original", ref: "o-x", locator: "全体" };
    expectStatus(await applyChange(db, ward.wardId, project.projectId, item(unknownYear, "10月25日")), "applied");
    const date = (await getProjectState(db, ward.wardId, project.projectId))?.items.find((i) => i.key === "date_time");
    expect(date?.current).toBeNull();
    expect(date?.references[0]).toMatchObject({ scope: "reference", refYear: null });
  });

  it("QRの紙から読んだ物と、今年の日付の資料の物と、人の入力は今年に入る", async () => {
    const { ward, account, project } = await setup();
    const qr: Source = { kind: "original", ref: "o-qr", locator: "欄1", qr: true };
    expectStatus(await applyChange(db, ward.wardId, project.projectId, item(qr, "10月24日11時")), "applied");
    const place = { itemKey: "place" as const, confidence: "high" as const, packVersion: "p" };
    expectStatus(
      await applyChange(db, ward.wardId, project.projectId, { kind: "item", value: "公民館", source: paper("o-this"), ...place }),
      "applied",
    );
    expectStatus(
      await applyChange(db, ward.wardId, project.projectId, { kind: "item", itemKey: "belongings", value: "水筒", source: person(account.accountId), confidence: "high", packVersion: "p" }),
      "applied",
    );
    const state = await getProjectState(db, ward.wardId, project.projectId);
    const current = (key: string) => state?.items.find((i) => i.key === key)?.current;
    expect(current("date_time")?.source).toMatchObject({ kind: "original", ref: "o-qr" });
    expect(current("place")?.content).toBe("公民館");
    expect(current("belongings")?.source.kind).toBe("person");
  });

  it("AIの下書きは今年の中身に入るが、出どころの年は参考にした年", async () => {
    const { ward, project } = await setup();
    const proposal: Source = { kind: "ai_proposal", ref: "o-last", year: 2025 };
    expectStatus(await applyChange(db, ward.wardId, project.projectId, item(proposal, "10月24日")), "applied");
    const date = (await getProjectState(db, ward.wardId, project.projectId))?.items.find((i) => i.key === "date_time");
    expect(date?.current).toMatchObject({ content: "10月24日", source: { kind: "ai_proposal", year: 2025 } });
  });
});

describe("今年の中身がある項目に違う中身が来た時", () => {
  it("資料の中身は上書きせず、食い違いとして並べる", async () => {
    const { ward, account, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item(person(account.accountId), "10月24日11時"));
    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, item(paper("o-2"), "10月25日11時")),
      "conflict",
    );
    expect(result.questionIds).toHaveLength(1);
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.items.find((i) => i.key === "date_time")?.current?.content).toBe("10月24日11時");
    const q = state?.questions.find((x) => x.kind === "conflict");
    expect(q?.options).toEqual(["10月24日11時", "10月25日11時"]);
    expect(q?.text).toContain("食い違っています");
  });

  it("人の入力は役員の判断なので、今ある中身に代わる", async () => {
    const { ward, account, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item(paper("o-2"), "10月24日"));
    const result = expectStatus(await applyChange(db, ward.wardId, project.projectId, item(person(account.accountId), "10月25日")), "applied");
    expect(result.stateVersion).toBe(2);
    const date = (await getProjectState(db, ward.wardId, project.projectId))?.items.find((i) => i.key === "date_time");
    expect(date?.current?.content).toBe("10月25日");
    // 入れ替わった物は消えずに残る
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM project_item_values WHERE ward_id = ? AND project_id = ? AND item_key = 'date_time'").bind(ward.wardId, project.projectId).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it("AIの下書きは、決まった中身を上書きしない", async () => {
    const { ward, account, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item(person(account.accountId), "10月24日"));
    const result = await applyChange(db, ward.wardId, project.projectId, item({ kind: "ai_proposal", year: 2025 }, "10月25日"));
    expectStatus(result, "kept");
    expect((await getProjectState(db, ward.wardId, project.projectId))?.items.find((i) => i.key === "date_time")?.current?.content).toBe("10月24日");
  });

  it("今ある中身が下書きなら、資料の中身に入れ替わる", async () => {
    const { ward, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item({ kind: "ai_proposal", year: 2025 }, "10月25日"));
    expectStatus(await applyChange(db, ward.wardId, project.projectId, item(paper("o-3", { qr: true }), "10月24日")), "applied");
    expect((await getProjectState(db, ward.wardId, project.projectId))?.items.find((i) => i.key === "date_time")?.current?.source.kind).toBe("original");
  });

  it("同じ中身は「同じものでした」で、状態の版は上がらない", async () => {
    const { ward, account, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, item(person(account.accountId), "10月24日11時"));
    const result = expectStatus(await applyChange(db, ward.wardId, project.projectId, item(paper("o-4"), "10月24日11時")), "same");
    expect(result.stateVersion).toBe(1);
  });

  it("確かさが低い中身は入るが、質問にもなる", async () => {
    const { ward, project } = await setup();
    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, item(paper("o-5"), "10月24日", { confidence: "low" })),
      "applied",
    );
    expect(result.questionIds).toHaveLength(1);
    const q = (await getProjectState(db, ward.wardId, project.projectId))?.questions.find((x) => x.kind === "unreadable");
    expect(q?.text).toContain("自信がありません");
    expect(q?.source).toMatchObject({ kind: "original", ref: "o-5" });
  });
});

describe("表の行", () => {
  const sponsor = (source: Source, data: Record<string, string | number>, packVersion = "p1"): ChangeInput => ({
    kind: "row", table: "sponsors", data, source, confidence: "high", packVersion,
  });

  it("同じ相手（正規化した名前）に当たれば更新し、原文は書いたまま保存する", async () => {
    const { ward, project } = await setup();
    expectStatus(await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-a"), { name: "商店A", ask: "済" })), "applied");
    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-b"), { name: "商店A様", reply: "yes", amount: 6000 })),
      "applied",
    );
    expect(result.stateVersion).toBe(2);
    const rows = (await getProjectState(db, ward.wardId, project.projectId))?.tables.sponsors ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ name: "商店A", ask: "済", reply: "yes", amount: 6000 });
    expect(rows[0]?.source).toMatchObject({ kind: "original", ref: "o-b" });
  });

  it("去年の資料の行は参考に入り、今年の行と別に持つ", async () => {
    const { ward, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-last", { year: 2025 }), { name: "商店A", amount: 5000 }));
    await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-now"), { name: "商店A", amount: 6000 }));
    const rows = (await getProjectState(db, ward.wardId, project.projectId))?.tables.sponsors ?? [];
    expect(rows.map((r) => [r.scope, r.refYear, r.data.amount])).toEqual([["reference", 2025, 5000], ["current", null, 6000]]);
  });

  it("名前が似ているだけの行は保留して、同じ相手かを質問に並べる", async () => {
    const { ward, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-a"), { name: "商店A" }));
    const result = expectStatus(await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-b"), { name: "商店A本店", amount: 3000 })), "held");
    expect(result.questionIds).toHaveLength(1);
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.tables.sponsors).toHaveLength(1);
    expect(state?.questions.find((q) => q.kind === "conflict")?.text).toContain("同じ相手かもしれません");
  });

  it("人が入れた列は、資料の更新で上書きされず食い違いになる。他の列は更新される", async () => {
    const { ward, account, project } = await setup();
    await applyChange(db, ward.wardId, project.projectId, sponsor(person(account.accountId), { name: "商店A", amount: 6000 }));
    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-c"), { name: "商店A", amount: 5000, reply: "yes" })),
      "applied",
    );
    expect(result.conflictFields).toEqual(["amount"]);
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.tables.sponsors[0]?.data).toEqual({ name: "商店A", amount: 6000, reply: "yes" });
    expect(state?.questions.find((q) => q.kind === "conflict")?.text).toContain("額");
  });

  it("列の合わない行は捨てる", async () => {
    const { ward, project } = await setup();
    expectStatus(await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-a"), { name: "商店A", amount: -1 })), "dropped");
    expectStatus(await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-a"), { name: "商店A", phone: "000" })), "dropped");
    expectStatus(await applyChange(db, ward.wardId, project.projectId, sponsor(paper("o-a"), { amount: 100 })), "dropped");
  });
});

describe("古くなる文書", () => {
  it("頼っている項目が変わった文書だけに古い印が付く。知らせたものはそのまま残る", async () => {
    const { ward, account, project } = await setup();
    const announcement = await insertDocument(ward.wardId, project.projectId, "announcement");
    await insertDocument(ward.wardId, project.projectId, "duty_roster");
    await db
      .prepare("INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no, scope, body, based_on_state_version, origin, published_at) VALUES (?, ?, ?, ?, 1, 'public', '{}', 0, 'ai', ?)")
      .bind(newId(), ward.wardId, project.projectId, announcement, "2026-09-20T00:00:00.000Z")
      .run();

    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, item(person(account.accountId), "10月24日")),
      "applied",
    );
    expect(result.staleDocuments.sort()).toEqual(["announcement", "duty_roster"]);
    const state = await getProjectState(db, ward.wardId, project.projectId);
    const stale = Object.fromEntries((state?.documents ?? []).map((d) => [d.kind, d.stale]));
    expect(stale).toEqual({ announcement: true, duty_roster: true });
    // 出した版は残る
    expect(state?.documents.find((d) => d.kind === "announcement")?.publishedVersionNo).toBe(1);

    // 協賛の行は公開の案内に頼られていない
    const sponsorResult = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, {
        kind: "row", table: "sponsors", data: { name: "商店A" }, source: person(account.accountId), confidence: "high", packVersion: "p",
      }),
      "applied",
    );
    expect(sponsorResult.staleDocuments).toEqual([]);
  });

  it("古くなる文書を直接知らせる差分（stale）も受ける", async () => {
    const { ward, project } = await setup();
    await insertDocument(ward.wardId, project.projectId, "report");
    const result = expectStatus(
      await applyChange(db, ward.wardId, project.projectId, {
        kind: "stale", documents: ["report", "notice"], reason: "雨で会場が変わった", source: paper("o-rain"), confidence: "high", packVersion: "p",
      }),
      "applied",
    );
    expect(result.staleDocuments).toEqual(["report"]);
  });
});

describe("やること", () => {
  it("済み・進んだの印は出どころ付きで、前に進める向きだけ付く", async () => {
    const { ward, project } = await setup();
    const mark = (progress: "started" | "done", ref: string): ChangeInput => ({
      kind: "map_task", taskKey: "venue", progress, source: paper(ref), confidence: "high", packVersion: "p",
    });
    expectStatus(await applyChange(db, ward.wardId, project.projectId, mark("done", "o-permit")), "applied");
    expectStatus(await applyChange(db, ward.wardId, project.projectId, mark("started", "o-other")), "same");
    const venue = (await getProjectState(db, ward.wardId, project.projectId))?.mapTasks.find((t) => t.taskKey === "venue");
    expect(venue).toMatchObject({ progress: "done", progressSource: { kind: "original", ref: "o-permit" } });
  });

  it("やることにない仕事への当ては捨てる", async () => {
    const { ward, project } = await setup();
    const result = await applyChange(db, ward.wardId, project.projectId, {
      kind: "map_task", taskKey: "no-such-task", progress: "done", source: paper("o-1"), confidence: "high", packVersion: "p",
    });
    expectStatus(result, "dropped");
  });
});

describe("質問を書く", () => {
  it("書ける。同じ質問は二度並ばず、同じ印で中身が違えば受けない", async () => {
    const { ward, project } = await setup();
    const q = { kind: "decide" as const, text: "雨のときの会場は公民館のホールでよいですか", options: ["よい", "別にする"], packVersion: "p1" };
    const first = await addQuestion(db, ward.wardId, project.projectId, q);
    expect(first.status).toBe("added");
    const second = await addQuestion(db, ward.wardId, project.projectId, q);
    expect(second).toMatchObject({ status: "same" });
    expect((second as { questionId: string }).questionId).toBe((first as { questionId: string }).questionId);
    expect(await addQuestion(db, ward.wardId, project.projectId, { ...q, kind: "map_gap" })).toEqual({ status: "rejected", reason: "key_reused" });
    const state = await getProjectState(db, ward.wardId, project.projectId);
    expect(state?.questions.filter((x) => x.kind === "decide")).toHaveLength(1);
  });

  it("捨てた差分の質問（discarded）は書く手では作れない", async () => {
    const { ward, project } = await setup();
    const result = await addQuestion(db, ward.wardId, project.projectId, {
      kind: "discarded" as unknown as "decide", text: "x", packVersion: "p",
    });
    expect(result).toMatchObject({ status: "rejected", reason: "bad_input" });
  });

  it("実在しない元の資料の読めなかったところは受けない", async () => {
    const { ward, project } = await setup();
    const result = await addQuestion(
      db, ward.wardId, project.projectId,
      { kind: "unreadable", text: "金額が読めません", source: paper("no-such"), packVersion: "p" },
      { verifyOriginal: async () => false },
    );
    expect(result).toMatchObject({ status: "rejected", reason: "bad_source" });
  });

  it("別の区の行事には書けない", async () => {
    const a = await setup();
    const b = await seedWard(db);
    expect(await addQuestion(db, b.wardId, a.project.projectId, { kind: "decide", text: "x", packVersion: "p" })).toEqual({
      status: "rejected",
      reason: "no_project",
    });
  });
});
