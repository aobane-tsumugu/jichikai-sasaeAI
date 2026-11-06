import { Hono } from "hono";
import type { AdminEnv } from "../env";
import { AdminPage, adminResult } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { newId } from "../core/ids";
import { Notice } from "../core/ui";
import {
  addHelpOffer, cancelHelpOffer, getHelpOffer, helpTimeChoices, listHelpOpportunities,
  restoreHelpOffer, updateHelpOffer, type HelpOpportunity,
} from "./help";

const str = (value: unknown) => typeof value === "string" ? value : "";
const rootOf = (slug: string, projectId: string) => adminPath({ slug }, `/answers/${encodeURIComponent(projectId)}`);

function OfferFields({ name, times, choices }: { name: string; times: string; choices: string[] }) {
  return <>
    <label for="help-name">お名前</label><input id="help-name" name="helper_name" value={name} maxlength={120} required />
    <label for="help-times">手伝える時間帯</label>
    {choices.length ? <select id="help-times" name="helper_times" required><option value="">選んでください</option>{choices.map((time) => <option value={time} selected={times === time}>{time}</option>)}</select>
      : <input id="help-times" name="helper_times" value={times} maxlength={240} required />}
  </>;
}

function EntryForm({ root, opportunity, name = "", times = "", submissionId, error }: {
  root: string; opportunity: HelpOpportunity; name?: string; times?: string; submissionId: string; error?: string;
}) {
  return <>
    <h1>電話や紙の手伝いの申し込みを入れる</h1>
    <p class="lead">{opportunity.title}で手伝う方のお名前と時間帯を入れてください。世帯の出欠には入りません。</p>
    {error ? <Notice error>{error} 入れた内容は残っています。</Notice> : null}
    <form method="post" action={`${root}/help`}>
      <input type="hidden" name="submission_id" value={submissionId} />
      <OfferFields name={name} times={times} choices={helpTimeChoices(opportunity.body)} />
      <div class="action-bar"><button>手伝いの申し込みを入れる</button></div>
    </form>
    <a class="quiet" href={`${root}?view=helpers`}>手伝いの一覧に戻る</a>
  </>;
}

export function installHelpAdminRoutes(admin: Hono<AdminEnv>) {
  admin.get("/answers/:projectId/help", async (c) => {
    const { ward, account } = c.var;
    const root = rootOf(ward.slug, c.req.param("projectId"));
    const [opportunity] = await listHelpOpportunities(c.env.DB, ward.wardId, c.req.param("projectId"));
    if (!opportunity) return adminResult(c, "手伝いの受付は終わりました。", 409, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "募集と締切を確かめてください。入っている申し込みは一覧から直せます。");
    return c.html(<AdminPage ward={ward} account={account} title="手伝いの申し込みを入れる" back={{ href: `${root}?view=helpers`, label: "← 手伝いの一覧へ" }}>
      <EntryForm root={root} opportunity={opportunity} submissionId={newId()} />
    </AdminPage>);
  });

  admin.post("/answers/:projectId/help", async (c) => {
    const { ward, account } = c.var;
    const projectId = c.req.param("projectId");
    const root = rootOf(ward.slug, projectId);
    const form = await c.req.parseBody();
    const name = str(form.helper_name).trim();
    const times = str(form.helper_times).trim();
    const submissionId = str(form.submission_id) || newId();
    const [opportunity] = await listHelpOpportunities(c.env.DB, ward.wardId, projectId);
    if (!opportunity) return adminResult(c, "手伝いの受付は終わりました。", 409, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "募集と締切を確かめてください。");
    const choices = helpTimeChoices(opportunity.body);
    const error = !name || !times ? "お名前と手伝える時間帯を入れてください。"
      : name.length > 120 || times.length > 240 ? "お名前か時間帯が長すぎます。短くしてください。"
      : choices.length && !choices.includes(times) ? "募集にある時間帯を選んでください。" : "";
    if (error) return c.html(<AdminPage ward={ward} account={account} title="申し込みの内容を確認してください" back={{ href: `${root}?view=helpers`, label: "← 手伝いの一覧へ" }}>
      <EntryForm root={root} opportunity={opportunity} name={name} times={times} submissionId={submissionId} error={error} />
    </AdminPage>, 400);
    const offer = await addHelpOffer(c.env.DB, ward.wardId, projectId, name, times, submissionId);
    if (!offer) return adminResult(c, "申し込みを入れられませんでした。", 409, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "募集と締切を確かめてください。");
    return c.redirect(`${root}/help/${encodeURIComponent(offer.offerId)}?done=added`, 303);
  });

  admin.get("/answers/:projectId/help/:offerId", async (c) => {
    const { ward, account } = c.var;
    const projectId = c.req.param("projectId");
    const offer = await getHelpOffer(c.env.DB, ward.wardId, projectId, c.req.param("offerId"));
    if (!offer) return c.notFound();
    const root = rootOf(ward.slug, projectId);
    const endpoint = `${root}/help/${encodeURIComponent(offer.offerId)}`;
    return c.html(<AdminPage ward={ward} account={account} title="手伝いの申し込みを直す" back={{ href: `${root}?view=helpers`, label: "← 手伝いの一覧へ" }}>
      <h1>{offer.name}さんの手伝いの申し込み</h1>
      <p class="lead">連絡を受けた時間帯に直せます。手伝えなくなったときは、下から申し込みを取り消せます。</p>
      {c.req.query("done") ? <Notice>{c.req.query("done") === "added" ? "申し込みを入れました。" : "申し込みを直しました。"}手伝いの人数と当番表の候補に入りました。</Notice> : null}
      <form method="post" action={`${endpoint}/edit`}>
        <label for="edit-help-times">手伝える時間帯</label><input id="edit-help-times" name="helper_times" value={offer.times} maxlength={240} required />
        <div class="action-bar"><button>時間帯を保存する</button></div>
        <a class="quiet" href={`${root}?view=helpers`}>保存せずに戻る</a>
      </form>
      <details class="fold"><summary>申し込みを取り消す</summary><div>
        <p>手伝いの人数と、これから作る当番表の候補から外れます。既に作った当番表は、別に直してください。</p>
        <form method="post" action={`${endpoint}/cancel`}><button class="danger">この申し込みを取り消す</button></form>
      </div></details>
    </AdminPage>);
  });

  admin.post("/answers/:projectId/help/:offerId/edit", async (c) => {
    const root = rootOf(c.var.ward.slug, c.req.param("projectId"));
    const endpoint = `${root}/help/${encodeURIComponent(c.req.param("offerId"))}`;
    const form = await c.req.parseBody();
    const times = str(form.helper_times).trim();
    if (!times || times.length > 240) return adminResult(c, "手伝える時間帯を240文字までで入れてください。", 400, { href: endpoint, label: "申し込みに戻る" }, "戻って時間帯を書き直してください。");
    const saved = await updateHelpOffer(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("offerId"), times);
    if (!saved) return adminResult(c, "申し込みを直せませんでした。", 409, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "一覧で申し込みを確かめてください。");
    return c.redirect(`${endpoint}?done=edited`, 303);
  });

  admin.post("/answers/:projectId/help/:offerId/cancel", async (c) => {
    const { ward, account } = c.var;
    const projectId = c.req.param("projectId");
    const root = rootOf(ward.slug, projectId);
    const offer = await cancelHelpOffer(c.env.DB, ward.wardId, projectId, c.req.param("offerId"));
    if (!offer) return adminResult(c, "申し込みを取り消せませんでした。", 409, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "一覧で申し込みを確かめてください。");
    return c.html(<AdminPage ward={ward} account={account} title="手伝いの申し込みを取り消しました" back={{ href: `${root}?view=helpers`, label: "← 手伝いの一覧へ" }}>
      <h1>{offer.name}さんの申し込みを取り消しました</h1>
      <p class="lead">手伝いの人数と当番表の候補から外しました。既に作った当番表は、別に直してください。</p>
      <a class="button" href={`${root}?view=helpers`}>手伝いの一覧へ</a>
      <h2>押し間違えたときは</h2>
      <form method="post" action={`${root}/help/${encodeURIComponent(offer.offerId)}/restore`}>
        <input type="hidden" name="helper_name" value={offer.name} /><input type="hidden" name="helper_times" value={offer.times} />
        <input type="hidden" name="submission_id" value={offer.submissionId ?? ""} /><input type="hidden" name="created_at" value={offer.createdAt} />
        <button class="secondary">取消を元に戻す</button>
      </form>
    </AdminPage>);
  });

  admin.post("/answers/:projectId/help/:offerId/restore", async (c) => {
    const root = rootOf(c.var.ward.slug, c.req.param("projectId"));
    const form = await c.req.parseBody();
    const name = str(form.helper_name).trim();
    const times = str(form.helper_times).trim();
    const createdAt = str(form.created_at);
    if (!name || !times || name.length > 120 || times.length > 240 || !Number.isFinite(Date.parse(createdAt))) {
      return adminResult(c, "申し込みを元に戻せませんでした。", 400, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "申し込みの内容を確かめて、もう一度入れてください。");
    }
    const restored = await restoreHelpOffer(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), {
      offerId: c.req.param("offerId"), name, times, createdAt, submissionId: str(form.submission_id) || null,
    });
    if (!restored) return adminResult(c, "申し込みを元に戻せませんでした。", 409, { href: `${root}?view=helpers`, label: "手伝いの一覧へ" }, "一覧で申し込みを確かめてください。閉じた行事は、先にもう一度開いてください。");
    return c.redirect(`${root}?view=helpers`, 303);
  });
}
