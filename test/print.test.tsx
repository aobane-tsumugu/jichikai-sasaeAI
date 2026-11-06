import jsQR from "jsqr";
import { Hono } from "hono";
import { articleParagraphs } from "../src/publish";
import { describe, expect, it } from "vitest";
import { CutLine, FieldBox, PrintDocument, PrintQr, Sheet } from "../src/print";
import { parsePrintQrUrl, printQrUrl, qrMatrix, qrSvg } from "../src/print";

/** QR のモジュールを画素にして jsQR で読み戻す（紙に刷って読む代わり）。 */
function decode(text: string, options?: { border?: number }): string | null {
  const matrix = qrMatrix(text, options);
  const scale = 6;
  const size = matrix.length * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark = matrix[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
      const i = (y * size + x) * 4;
      const v = dark ? 0 : 255;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return jsQR(rgba, size, size)?.data ?? null;
}

describe("QRの部品", () => {
  it("紙のQRのURLを読み戻すと元の文字になる（日本語の班名を含む）", () => {
    const url = printQrUrl("https://example.test", "demo-ward", {
      projectId: "proj_1",
      documentId: "doc-answer",
      version: 2,
      squad: "2班",
    });
    expect(url).toBe("https://example.test/demo-ward/q/proj_1/doc-answer/2?s=2%E7%8F%AD");
    expect(decode(url)).toBe(url);
  });

  it("区の固定URLのような短い文字も読める", () => {
    const url = "https://example.test/demo-ward/";
    expect(decode(url)).toBe(url);
  });

  it("URLをPrintCodeに戻せる。形が違えばnull", () => {
    const url = printQrUrl("https://example.test/", "demo-ward", { projectId: "p1", documentId: "d1", version: 3 });
    expect(parsePrintQrUrl(url)).toEqual({
      wardSlug: "demo-ward",
      code: { projectId: "p1", documentId: "d1", version: 3 },
    });
    const withSquad = printQrUrl("https://example.test", "demo-ward", {
      projectId: "p1",
      documentId: "d1",
      version: 1,
      squad: "1班",
    });
    expect(parsePrintQrUrl(withSquad)?.code.squad).toBe("1班");
    for (const bad of ["not a url", "https://example.test/demo-ward/", "https://example.test/demo-ward/q/p1/d1/0", "https://example.test/demo-ward/q/p1/d1"]) {
      expect(parsePrintQrUrl(bad), bad).toBeNull();
    }
  });

  it("不正な識別子と版は作らない", () => {
    expect(() => printQrUrl("https://example.test", "w", { projectId: "a/b", documentId: "d", version: 1 })).toThrow();
    expect(() => printQrUrl("https://example.test", "w", { projectId: "p", documentId: "d", version: 0 })).toThrow();
    expect(() => printQrUrl("https://example.test", "w", { projectId: "p", documentId: "d", version: 1.5 })).toThrow();
  });

  it("SVGは白地に黒で、内容によって変わる", () => {
    const a = qrSvg("https://example.test/a");
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain('fill="white"');
    expect(a).toContain('fill="black"');
    expect(qrSvg("https://example.test/b")).not.toBe(a);
  });
});

describe("A4の版面", () => {
  const app = new Hono().get("/", (c) =>
    c.html(
      <PrintDocument title="試験の案内（架空）">
        <Sheet footer={<span>架空の区</span>}>
          <h1>試験の案内</h1>
          <FieldBox label="代表者のお名前" />
          <CutLine />
          <PrintQr text="https://example.test/demo-ward/" caption="https://example.test/demo-ward/" sizeMm={30} />
        </Sheet>
        <Sheet>
          <p>2枚目</p>
        </Sheet>
      </PrintDocument>,
    ),
  );

  it("A4、余白なし、印刷の帯は紙に出さない", async () => {
    const res = await app.request("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("@page { size: A4 portrait; margin: 0; }");
    expect(html).toContain(".toolbar { display: none; }");
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain("window.print()");
  });

  it("枚ごとに区切られ、切り取り線とQRと記入欄が出る", async () => {
    const html = await (await app.request("/")).text();
    expect(html.match(/class="sheet"/g)?.length).toBe(2);
    expect(html).toContain("ここで切り取る");
    expect(html).toContain("<svg");
    expect(html).toContain("width:30mm");
    expect(html).toContain("代表者のお名前");
    expect(html).toContain("架空の区");
  });

  it("タイトルなどの文字はescapeされる", async () => {
    const hostile = new Hono().get("/", (c) =>
      c.html(
        <PrintDocument title={'<script>alert(1)</script>'}>
          <Sheet>
            <p>{"<img src=x onerror=alert(1)>"}</p>
          </Sheet>
        </PrintDocument>,
      ),
    );
    const html = await (await hostile.request("/")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
  });
});

describe("読む人に見せる本文", () => {
  it("文を段落に分け、項目の名前を出さない", () => {
    const body = JSON.stringify({ text: "秋の案内\r\n\r\n日時: 10月24日", items: [{ key: "date_time", content: "10月24日" }] });
    expect(articleParagraphs(body)).toEqual(["秋の案内", "日時: 10月24日"]);
  });
  it("文にない項目は見出しを付けて足す", () => {
    const body = JSON.stringify({ text: "秋の案内", items: [{ key: "rain_plan", content: "公民館" }] });
    expect(articleParagraphs(body)).toEqual(["秋の案内", "雨のとき: 公民館"]);
  });
});
