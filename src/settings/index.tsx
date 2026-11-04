import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath, clearDeviceCookie } from "../core/auth";
import { Layout } from "../core/ui";
import type { AdminEnv } from "../env";

// 束 1: 区の設定（席とアカウントなど）と役員画面の入口。
// 席とアカウントの足す・外す・初期化・端末の締め出しは次の段で /settings に置く。

const admin = new Hono<AdminEnv>();

admin.get("/", (c) => {
  const { ward, account } = c.var;
  return c.html(
    <Layout
      title={`${ward.name} 役員画面`}
      siteName={ward.name}
      noindex
      headerRight={
        <form class="inline" method="post" action={adminPath(ward, "/logout")}>
          <span class="muted">{account.name} </span>
          <button type="submit" class="secondary">
            ログアウト
          </button>
        </form>
      }
    >
      <h1>役員画面</h1>
      <p class="muted">プロジェクトの地図などは、これから足します。</p>
    </Layout>,
  );
});

// この端末の記憶を消してログアウトする。ほかの端末には影響しない。
admin.post("/logout", async (c) => {
  const ward = c.var.ward;
  await c.env.DB.prepare("DELETE FROM devices WHERE ward_id = ? AND device_id = ?")
    .bind(ward.wardId, c.var.deviceId)
    .run();
  clearDeviceCookie(c, ward);
  return c.redirect(adminPath(ward, "/login"), 303);
});

export const settings: Bundle = { admin };
