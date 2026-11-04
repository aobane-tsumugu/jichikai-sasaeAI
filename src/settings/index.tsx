import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath, clearDeviceCookie } from "../core/auth";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";
import { info } from "./info";
import { people } from "./people";
import { templates } from "./templates";

// 束 1: 区の設定（席とアカウント、区の情報、定型文）と役員画面の入口。
// 他の束が設定を読む入口は store.ts（getPublicContact、getSquads、getTemplates）と keys.ts。

const admin = new Hono<AdminEnv>();

admin.get("/", (c) => {
  const { ward, account } = c.var;
  return c.html(
    <AdminPage ward={ward} account={account} title="役員画面">
      <h1>役員画面</h1>
      <p class="muted">プロジェクトの地図などは、これから足します。</p>
      <p>
        <a class="button secondary" href={adminPath(ward, "/settings")}>
          区の設定
        </a>
      </p>
    </AdminPage>,
  );
});

admin.get("/settings", (c) => {
  const { ward, account } = c.var;
  return c.html(
    <AdminPage ward={ward} account={account} title="区の設定" back={{ href: adminPath(ward, "/"), label: "役員画面" }}>
      <h1>区の設定</h1>
      <ul>
        <li>
          <a href={adminPath(ward, "/settings/people")}>役員の席とアカウント</a>
          （足す、外す、パスワードの作り直し、なくした端末の締め出し）
        </li>
        <li>
          <a href={adminPath(ward, "/settings/info")}>区の情報</a>（公開用の連絡先、班の名前）
        </li>
        <li>
          <a href={adminPath(ward, "/settings/templates")}>定型文</a>（雨天の変更の知らせなど）
        </li>
      </ul>
    </AdminPage>,
  );
});

admin.route("/settings/people", people);
admin.route("/settings/info", info);
admin.route("/settings/templates", templates);

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
