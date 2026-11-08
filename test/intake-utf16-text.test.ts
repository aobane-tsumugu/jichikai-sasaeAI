import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { getReadings } from "../src/intake/store";
import { createProject } from "../src/project/api";

it("ExcelのUnicodeテキストを、UTF-16のどちらのバイト順でも同じ本文として受け取る", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの行事", year: 2026, accountId: account.accountId,
  });
  const text = "代表者のお名前\t班\r\n世帯\t1班\r\n";
  for (const littleEndian of [true, false]) {
    // Excel の「Unicode テキスト」と同じく、BOM とタブを含む試しの資料。
    const bytes = new Uint8Array(2 + text.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, littleEndian);
    for (let index = 0; index < text.length; index++) {
      view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
    }
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "file", filename: "試しの世帯.txt", mediaType: "text/plain", bytes }],
    });
    expect(received.received).toHaveLength(1);
    expect(received.needsModelRead).toBe(false);
    if (!received.jobId) throw new Error("資料が新しく受け付けられていません。");
    expect(await getReadings(env.DB, ward.wardId, received.jobId)).toMatchObject([
      { source: "direct", body: { text_blocks: [
        { locator: "1行目", text: "代表者のお名前\t班" },
        { locator: "2行目", text: "世帯\t1班" },
      ] } },
    ]);
  }
});
