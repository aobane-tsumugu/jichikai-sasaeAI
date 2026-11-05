import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath, clearDeviceCookie } from "../core/auth";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";
import { listOpenProjects } from "../project/api";
import { listInboxItems } from "../line";
import { info } from "./info";
import { people } from "./people";
import { templates } from "./templates";
import { deletion } from "./deletion";

// 束 1: 区の設定（席とアカウント、区の情報、定型文）と役員画面の入口。
// 他の束が設定を読む入口は store.ts（getPublicContact、getSquads、getTemplates）と keys.ts。

const admin = new Hono<AdminEnv>();

admin.get("/", async (c) => {
  const { ward, account } = c.var;
  const [projects, lineInbox, unmatchedCityCount] = await Promise.all([
    listOpenProjects(c.env.DB, ward.wardId),
    listInboxItems(c.env.DB, ward.wardId),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE ward_id = ? AND project_id IS NULL AND via = 'admin' AND withdrawn_at IS NULL")
      .bind(ward.wardId).first<{ count: number }>(),
  ]);
  const inboxCount = lineInbox.filter((item) => item.disposition === "unmatched").length + (unmatchedCityCount?.count ?? 0);
  return c.html(
    <AdminPage ward={ward} account={account} title="役員画面">
      <h1>役員画面</h1>
      <h2>開いているプロジェクト</h2>
      {projects.map((project) => <section class="panel">
        <h3><a href={adminPath(ward, `/projects/${project.projectId}/map`)}>{project.title}</a></h3>
        <p>{project.year}年</p>
      </section>)}
      {projects.length === 0 ? <p>開いているプロジェクトはありません。</p> : null}
      <nav class="action-links">
        <a class="button" href={adminPath(ward, "/projects/today")}>今やること</a>
        <a class="button secondary" href={adminPath(ward, "/projects")}>新しいプロジェクト</a>
        <a class="button secondary" href={adminPath(ward, "/inbox")}>受け箱（{inboxCount}件）</a>
        <a class="button secondary" href={adminPath(ward, "/answers/roster")}>名簿</a>
        <a class="button secondary" href={adminPath(ward, "/archive")}>記録</a>
        <a class="button secondary" href={adminPath(ward, "/settings")}>区の設定</a>
        <a class="button secondary" href={adminPath(ward, "/intake")}>材料を送る</a>
        <a class="button secondary" href={adminPath(ward, "/requests/city")}>行政の依頼</a>
        <a class="button secondary" href={adminPath(ward, "/inquiries")}>問い合わせと要望</a>
        <a class="button secondary" href={adminPath(ward, "/ledger")}>帳簿</a>
      </nav>
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
        <li><a href={adminPath(ward, "/settings/deletion")}>消す求め</a>（住民から届いた希望の処理）</li>
        <li>
          <a href={adminPath(ward, "/settings/templates")}>定型文</a>（雨天の変更の知らせなど）
        </li>
      </ul>
    </AdminPage>,
  );
});

admin.route("/settings/people", people);
admin.route("/settings/info", info);
admin.route("/settings/deletion", deletion);
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
