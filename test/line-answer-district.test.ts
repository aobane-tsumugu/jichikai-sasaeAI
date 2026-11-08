import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getAnswerTotals, listAnswers, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createLineIntakePorts } from "../src/line/intake";
import { createProject } from "../src/project/api";

it("別の班の同名世帯のLINE答えを分け、班が分からない返事も書かれたまま数える", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの行事", year: 2026, accountId: account.accountId,
  });
  await replaceRoster(env.DB, ward.wardId, [
    { household: "同名世帯", district: "1班" },
    { household: "同名世帯", district: "2班" },
  ], { household: 0, district: 1 });
  const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
  async function reply(text: string) {
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "line_direct",
      parts: [{ kind: "text", filename: "試しのLINEの文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }],
    });
    await ports.saveAnswerReply!(ward.wardId, project.projectId, {
      eventId: crypto.randomUUID(), senderId: "試しの送信者", sourceType: "user", receivedAt: new Date().toISOString(), kind: "text", text,
    }, received.jobId!);
  }
  await reply("同名世帯です。大人4人です。");
  expect(await listAnswers(env.DB, ward.wardId, project.projectId))
    .toMatchObject([{ household: "同名世帯", district: "", peopleCount: 4, source: "line" }]);
  await reply("2班の同名世帯です。大人2人です。");
  expect(await listAnswers(env.DB, ward.wardId, project.projectId))
    .toEqual(expect.arrayContaining([expect.objectContaining({ household: "同名世帯", district: "2班", peopleCount: 2, source: "line" })]));
  await reply("1班の同名世帯です。大人3人です。");
  const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(answers).toHaveLength(3);
  expect(answers).toEqual(expect.arrayContaining([
    expect.objectContaining({ district: "1班", peopleCount: 3 }),
    expect.objectContaining({ district: "2班", peopleCount: 2 }),
  ]));
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(9);
});
