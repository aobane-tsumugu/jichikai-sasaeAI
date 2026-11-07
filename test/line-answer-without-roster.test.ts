import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getAnswerTotals, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createLineIntakePorts } from "../src/line/intake";
import { createProject } from "../src/project/api";

it("名簿のないLINEの返事で、人数を名前として保存せず、名乗った名前は保つ", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
  const replies = [
    { text: "大人1人です。", household: "名前の分からない答え", peopleCount: 1 },
    { text: "大人２人です。", household: "名前の分からない答え", peopleCount: 2 },
    { text: "子ども1人です。", household: "名前の分からない答え", peopleCount: 1 },
    { text: "子供１人です。", household: "名前の分からない答え", peopleCount: 1 },
    { text: "高齢の方1人です。", household: "名前の分からない答え", peopleCount: 1 },
    { text: "シニア１人です。", household: "名前の分からない答え", peopleCount: 1 },
    { text: "来場は３人です。", household: "名前の分からない答え", peopleCount: 3 },
    { text: "2人です。", household: "名前の分からない答え", peopleCount: 2 },
    { text: "大人2人、子供１人です。", household: "名前の分からない答え", peopleCount: 3 },
    { text: "一世帯（架空）です。大人2人です。", household: "一世帯（架空）", peopleCount: 2 },
    { text: "二世帯（架空）家は大人3人です。", household: "二世帯（架空）", peopleCount: 3 },
  ];
  for (const { text, household, peopleCount } of replies) {
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "line_direct",
      parts: [{ kind: "text", filename: "架空のLINEの文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }],
    });
    const originalId = received.received[0]?.originalId;
    if (!received.jobId || !originalId || !ports.saveAnswerReply) throw new Error("架空のLINEの返事を受け付けられません");
    await ports.saveAnswerReply(ward.wardId, project.projectId, {
      eventId: crypto.randomUUID(), senderId: "架空の送信者", sourceType: "user",
      receivedAt: new Date().toISOString(), kind: "text", text,
    }, received.jobId);
    const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
    expect(answers.filter((answer) => answer.originalId === originalId))
      .toMatchObject([{ household, district: "", peopleCount, source: "line" }]);
  }
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(replies.length);
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people)
    .toBe(replies.reduce((total, reply) => total + reply.peopleCount, 0));
});
