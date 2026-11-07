import { PROJECT_KINDS, PROJECT_KIND_LABEL } from "../project/model";

export interface ProjectChoice { project_id: string; name: string }

/**
 * 「この写真は、次の行事のものですか」の問い。届いたものの一覧でも、開いた画面でも、読み終わった資料でも同じ形にする。
 * 行事の名前を押せば、そのまま入る。「この中にない」を選ぶと、新しい行事の名前を聞く。
 */
export function WhichProject({ id, question, projects, suggested, suggestedName, suggestedKind, action, hidden, withDay }: {
  id: string; question: string; projects: readonly ProjectChoice[]; suggested?: string | null; suggestedName?: string; suggestedKind?: string;
  action: string; hidden?: Record<string, string>; withDay?: boolean;
}) {
  const year = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  const ordered = [...projects].sort((a, b) => Number(b.project_id === suggested) - Number(a.project_id === suggested));
  const fields = Object.entries(hidden ?? {}).map(([name, value]) => <input type="hidden" name={name} value={value} />);
  const kind = PROJECT_KINDS.some((value) => value === suggestedKind) ? suggestedKind : "event";
  return <div class="which-project">
    {ordered.length ? <form method="post" action={action}>{fields}<input type="hidden" name="operation" value="assign" />
      <fieldset><legend>{question}</legend><div class="action-links">
        {ordered.map((project, index) => <button class={suggested && index === 0 ? undefined : "secondary"} name="projectId" value={project.project_id}>{project.name}</button>)}
      </div></fieldset>
    </form> : <p><b>準備中のものはありません。新しく準備を始めますか？</b></p>}
    <details class="none-of-these" open={!ordered.length || Boolean(suggestedName && !suggested)}><summary>{ordered.length ? "この中にない" : "新しく準備を始める"}</summary><div>
      <form method="post" action={action}>{fields}<input type="hidden" name="operation" value="new-project" /><input type="hidden" name="year" value={String(year)} />
        <div class="field"><label for={`${id}-name`}>新しく始めるものの名前</label><input id={`${id}-name`} name="projectName" type="text" maxlength={100} value={suggestedName ?? ""} required /><p class="help-text">あとで直せます。</p></div>
        <fieldset><legend>種類</legend><div class="choice half">{PROJECT_KINDS.map((value) => <label><input type="radio" name="kind" value={value} checked={value === kind} /> {PROJECT_KIND_LABEL[value]}</label>)}</div></fieldset>
        {withDay ? <div class="field"><label for={`${id}-day`}>当日（分かれば。あとでも直せます）</label><input id={`${id}-day`} name="eventDay" type="date" /></div> : null}
        <button class="secondary">この名前で新しく準備を始める</button>
      </form>
    </div></details>
  </div>;
}
