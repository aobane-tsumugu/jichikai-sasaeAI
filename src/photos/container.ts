import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** 提供側の写真処理。実資源の設定と配備はPMが行う。 */
export class FaceMaskContainer extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/mask") return new Response(null, { status: 404 });
    const container = this.ctx.container;
    if (!container) return new Response(null, { status: 503 });
    return forwardPhotoToContainer(container, request);
  }
}

export async function forwardPhotoToContainer(container: Pick<Container,
  "running" | "start" | "getTcpPort" | "setInactivityTimeout">, request: Request): Promise<Response> {
  // 同じDOの中でのみ起動する。起動後の通信や写真の保存はしない。
  if (!container.running) container.start({ enableInternet: false });
  await container.setInactivityTimeout(60_000);
  const port = container.getTcpPort(8080);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    // start()はポートの準備を待たない。本文を送る前のhealthだけ再試行する。
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const health = await port.fetch("http://container/health", { signal: controller.signal });
        if (health.ok) { ready = true; break; }
      } catch { if (controller.signal.aborted) break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) return new Response(null, { status: 503 });
    const result = await port.fetch(new Request("http://container/mask", {
      method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "application/octet-stream" },
      body: await boundedPhotoBody(new Response(request.body), 11_000_000), signal: controller.signal,
    }));
    // 応答の読出しまで時間制限の内側に置く。
    const bytes = await boundedPhotoBody(result, 1_100_000);
    return new Response(bytes, { status: result.status, headers: { "content-type": "application/json" } });
  } catch { return new Response(null, { status: 503 }); }
  finally { clearTimeout(timer); }
}

export async function boundedPhotoBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("写真の応答がありません。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error("写真が大きすぎます。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

