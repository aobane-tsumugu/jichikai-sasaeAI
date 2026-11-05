import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { get, realApp } from "./helpers";

it("プロジェクト未定の資料をブラウザから送ると、受け箱へ進んでその資料が出る", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const form = {
    action: `${root}/intake`, elements: { text: { value: "" }, project_id: { value: "" } }, reset: vi.fn(),
    addEventListener: (_name: string, listener: typeof submit) => { submit = listener; },
  };
  const status = { textContent: "", className: "" };
  const button = { disabled: false };
  const file = new File(["架空の市の通知です。"], "架空の通知.txt", { type: "text/plain" });
  const elements = new Map<string, unknown>([
    ["send-form", form], ["send-status", status], ["send-button", button], ["files", { files: [file] }],
  ]);
  const location = { assign: vi.fn(), reload: vi.fn() };
  const send = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("origin", "http://localhost");
    headers.set("cookie", cookie);
    return realApp.request(path, { ...init, headers }, env);
  };
  new Function("window", "document", "fetch", "location", "setTimeout", SEND_SCRIPT)(
    {}, { getElementById: (id: string) => elements.get(id) ?? null }, send, location, (callback: () => void) => { callback(); },
  );
  expect(submit).toBeDefined();
  await submit!({ preventDefault: vi.fn() });
  expect(location.assign).toHaveBeenCalledWith(`${root}/inbox`);
  expect(location.reload).not.toHaveBeenCalled();
  const inbox = await get(realApp, `${root}/inbox`, cookie);
  expect(inbox.status).toBe(200);
  expect(await inbox.text()).toContain("架空の通知.txt");
});
