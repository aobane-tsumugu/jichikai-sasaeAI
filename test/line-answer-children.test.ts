import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getAnswerTotals, listAnswers, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createLineIntakePorts } from "../src/line/intake";
import { createProject } from "../src/project/api";

it("LINE の回答で「子ども」「子供」のどちらも人数に含める", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const replies = [
    { household: "架空世帯（甲）", children: "子ども" },
    { household: "架空世帯（乙）", children: "子供" },
  ];
  await replaceRoster(env.DB, ward.wardId,
    replies.map(({ household }) => ({ household, district: "1班" })),
    { household: 0, district: 1 });
  const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
  for (const { household, children } of replies) {
    const text = `1班の${household}です。大人2人、${children}1人です。`;
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "line_direct",
      parts: [{ kind: "text", filename: "架空のLINEの文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }],
    });
    if (!received.jobId) throw new Error("架空の回答の原本を受け付けられませんでした。");
    await ports.saveAnswerReply!(ward.wardId, project.projectId, {
      eventId: crypto.randomUUID(), senderId: "架空の送信者", sourceType: "user",
      receivedAt: new Date().toISOString(), kind: "text", text,
    }, received.jobId);
  }
  const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(answers).toHaveLength(2);
  expect(answers).toEqual(expect.arrayContaining(replies.map(({ household }) =>
    expect.objectContaining({ household, district: "1班", peopleCount: 3, source: "line" }))));
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(6);
});

it("LINE の全角数字と半角数字が混じる人数を読み、手伝える時間の文は保つ", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const replies = [
    { household: "架空世帯（丙）", counts: "大人２人、子供1人" },
    { household: "架空世帯（丁）", counts: "大人２人、子ども１人" },
    { household: "架空世帯（戊）", counts: "来場は３人" },
  ];
  await replaceRoster(env.DB, ward.wardId,
    replies.map(({ household }) => ({ household, district: "1班" })),
    { household: 0, district: 1 });
  const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
  for (const { household, counts } of replies) {
    const text = `1班の${household}です。${counts}。１２時なら手伝えます。`;
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "line_direct",
      parts: [{ kind: "text", filename: "架空のLINEの文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }],
    });
    if (!received.jobId) throw new Error("架空の回答の原本を受け付けられませんでした。");
    await ports.saveAnswerReply!(ward.wardId, project.projectId, {
      eventId: crypto.randomUUID(), senderId: "架空の送信者", sourceType: "user",
      receivedAt: new Date().toISOString(), kind: "text", text,
    }, received.jobId);
  }
  const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(answers).toEqual(expect.arrayContaining(replies.map(({ household }) =>
    expect.objectContaining({ household, district: "1班", peopleCount: 3, helperTimes: "１２時", source: "line" }))));
  expect(answers).toHaveLength(3);
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(9);
});
