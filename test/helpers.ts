import { env } from "cloudflare:workers";
import { createApp } from "../src/core/app";
import type { Bundle } from "../src/core/bundle";
import { bundles } from "../src/index";

export const realApp = createApp(Object.values(bundles));

/** Hono のアプリのうち、試験が使う request だけ。 */
export interface Requester {
  request(input: string, init?: RequestInit, env?: unknown): Response | Promise<Response>;
}

/** 運用の画面が使える環境（OPS_ID と OPS_PASSWORD を足した env）。 */
export const OPS_ID = "ops-test-id";
export const OPS_PASSWORD = "ops-test-password-long-and-random";
/** env に触れず、足した値だけを持つ子の env を作る。 */
export function withEnv(extra: Record<string, string>): typeof env {
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(extra)) descriptors[key] = { value, enumerable: true };
  return Object.create(env, descriptors) as typeof env;
}

export const opsEnv = withEnv({ OPS_ID, OPS_PASSWORD });

export function get(app: Requester, path: string, cookie?: string, bindings: unknown = env, headers: Record<string, string> = {}) {
  return app.request(path, { headers: { ...(cookie ? { cookie } : {}), ...headers } }, bindings);
}

/** フォームの POST。csrf の検査を通すため origin を付ける。 */
export function postForm(
  app: Requester,
  path: string,
  form: Record<string, string>,
  cookie?: string,
  bindings: unknown = env,
  headers: Record<string, string> = {},
) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    },
    bindings,
  );
}

/** Set-Cookie から name=value を取り出す。 */
export function cookieFrom(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair;
  }
  return null;
}

export function appWith(bundle: Bundle) {
  return createApp([...Object.values(bundles), bundle]);
}

/**
 * 準備の文書（一番新しい版）を、送る前の確かめの画面と同じ送り先で住民に送る（L-319 の一つの送り方）。
 * 報告も、終わりにする画面からではなく、この送り方で送る。LINE は送らない。
 */
export async function sendLatest(wardSlug: string, wardId: string, projectId: string, kind: string, cookie: string, bindings: unknown = env): Promise<Response> {
  const doc = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`).bind(wardId, projectId, kind).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!doc) throw new Error(`${kind} の下書きがありません`);
  return postForm(realApp, `/${wardSlug}/admin/publish/${projectId}/send`, { documentId: doc.document_id, versionId: doc.version_id, versionNo: String(doc.version_no), recipientScope: "member_households", lineDelivery: "skip" }, cookie, bindings);
}
