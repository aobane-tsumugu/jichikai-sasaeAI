import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { callTool } from "../src/ai/mcp";
import { newId, nowIso } from "../src/core/ids";
import { sha256Hex } from "../src/core/password";
import { seedWard } from "../src/core/testing";
import { createProject } from "../src/project/api";

const text = "今年の持ち物を教えてください（架空の問い）";

async function setup() {
  const ward = await seedWard(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026 });
  return { wardId: ward.wardId, projectId: project.projectId };
}

async function ticketFor(wardId: string, projectId: string) {
  const ticket = `tk_${newId()}`;
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, project_id, via, status, ticket_hash, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 'connecting', ?, ?, ?)`)
    .bind(newId(), wardId, projectId, await sha256Hex(ticket), nowIso(), nowIso()).run();
  return ticket;
}

async function ask(wardId: string, ticket: string, questionText = text) {
  const result = await callTool(env, wardId, "write_question", { ticket, kind: "decide", text: questionText });
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]?.text ?? "") as { status: string; note?: string; questionId: string };
}

async function questions(wardId: string, projectId: string) {
  return (await env.DB.prepare("SELECT question_id, text, state FROM project_questions WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).all<{ question_id: string; text: string; state: string }>()).results;
}

describe("AI が同じ問いを繰り返す時", () => {
  it("別の入力から前後に空白を付けて書いても、開いている問いを返す", async () => {
    const { wardId, projectId } = await setup();
    const first = await ask(wardId, await ticketFor(wardId, projectId));
    const second = await ask(wardId, await ticketFor(wardId, projectId), `　\n${text}\t `);
    expect(first.status).toBe("added");
    expect(second).toMatchObject({ status: "same", questionId: first.questionId, note: "同じ問いが既にあります" });
    expect(await questions(wardId, projectId)).toHaveLength(1);
  });

  it("後で答える問いも再利用する", async () => {
    const { wardId, projectId } = await setup();
    const first = await ask(wardId, await ticketFor(wardId, projectId));
    await env.DB.prepare("UPDATE project_questions SET state = 'later' WHERE ward_id = ? AND question_id = ?")
      .bind(wardId, first.questionId).run();
    expect(await ask(wardId, await ticketFor(wardId, projectId))).toMatchObject({ status: "same", questionId: first.questionId });
    expect(await questions(wardId, projectId)).toHaveLength(1);
  });

  it.each(["answered", "unknown"])("%s の後なら同じ入力からも新しい問いを作る", async (state) => {
    const { wardId, projectId } = await setup();
    const ticket = await ticketFor(wardId, projectId);
    const first = await ask(wardId, ticket);
    await env.DB.prepare("UPDATE project_questions SET state = ? WHERE ward_id = ? AND question_id = ?")
      .bind(state, wardId, first.questionId).run();
    const second = await ask(wardId, ticket);
    expect(second.status).toBe("added");
    expect(second.questionId).not.toBe(first.questionId);
    expect(await questions(wardId, projectId)).toHaveLength(2);
  });

  it("同時に同じ文を書いても一件だけを作る", async () => {
    const { wardId, projectId } = await setup();
    const a = await ticketFor(wardId, projectId);
    const b = await ticketFor(wardId, projectId);
    const results = await Promise.all([ask(wardId, a), ask(wardId, b)]);
    expect(results.map((r) => r.status).sort()).toEqual(["added", "same"]);
    expect(results[0]?.questionId).toBe(results[1]?.questionId);
    expect(await questions(wardId, projectId)).toHaveLength(1);
  });

  it("別のプロジェクトや別の区の同じ文はそれぞれ作る", async () => {
    const a = await setup();
    const b = await setup();
    const other = await createProject(env.DB, a.wardId, { kind: "event", title: "別の行事（架空）", year: 2026 });
    for (const target of [a, { wardId: a.wardId, projectId: other.projectId }, b]) {
      expect((await ask(target.wardId, await ticketFor(target.wardId, target.projectId))).status).toBe("added");
      expect(await questions(target.wardId, target.projectId)).toHaveLength(1);
    }
  });
});
