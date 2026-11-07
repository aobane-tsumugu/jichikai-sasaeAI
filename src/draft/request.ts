import type { Context } from "hono";
import type { AdminEnv } from "../env";
import { startTask } from "../ai/api";
import { getDutyDraftHelpers } from "../answers/api";
import type { DocumentKind } from "../project/model";
import type { ProjectSummary } from "../project/types";
import { getPublicContact } from "../settings/store";
import { draftMaterials } from "./materials";
import { getMeetingMaterials, meetingMaterialInstruction } from "./meeting-materials";
import { getDraftPack } from "./packs";
import { startMaterialDraft } from "./start";

/**
 * AIに下書きを頼む。下書きの画面の「AIに頼む」と、住民へのメッセージを作る画面の「作る」で同じ頼み方にする。
 * 頼めなかった時は例外を投げる。呼ぶ側が、手で書ける下書きの画面へ送る。
 */
export async function requestDraft(c: Context<AdminEnv>, project: ProjectSummary, kind: DocumentKind, instruction = ""): Promise<void> {
  const { ward, account } = c.var;
  const id = project.projectId;
  const pack = getDraftPack(kind, project.kind);
  const contact = await getPublicContact(c.env.DB, ward.wardId);
  const helpers = pack.kind === "duty_roster" ? await getDutyDraftHelpers(c.env.DB, ward.wardId, id) : [];
  const helperInstruction = helpers.length
    ? `\n答えから集めた手伝いの希望（この一覧を当番表の下書きに含めてください）: ${JSON.stringify(helpers)}`
    : "\n答えに手伝いの希望はまだありません。";
  const start = project.kind === "event" ? startTask : startMaterialDraft;
  const materials = project.kind === "event" ? "" : await draftMaterials(c.env.DB, ward.wardId, id);
  const meetingMaterials = pack.kind === "procedure" ? meetingMaterialInstruction(await getMeetingMaterials(c.env.DB, ward.wardId, project)) : "";
  await start(c.env, c.executionCtx, { wardId: ward.wardId, projectId: id, task: "draft", instruction: `${pack.instruction}${contact ? `\n区の公開用の連絡先（問い合わせ先に使う）: ${contact}` : ""}${instruction ? `\n役員からの頼み: ${instruction}` : ""}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。dataにpack_versionを${pack.version}、based_on_state_versionを引いた状態の番号として含めてください。${pack.kind === "duty_roster" ? helperInstruction : ""}${materials}${meetingMaterials}`, accountId: account.accountId });
}
