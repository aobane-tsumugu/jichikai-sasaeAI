export interface ProjectChoice { project_id: string; name: string }

/**
 * 「この写真は、次の行事のものですか」の問い。届いたものの一覧でも、開いた画面でも、読み終わった資料でも同じ形にする。
 * 行事の名前を押せば、そのまま入る。「この中にない」を選ぶと、新しい行事の名前を聞く。
 */
/** 押した後すぐにボタンを止める。始める操作は数秒かかり、二度押すと同じ準備が二つできるため。送る値が消えないよう、送信の後に止める。 */
const ONCE = "setTimeout(() => this.querySelectorAll('button').forEach((b) => { b.disabled = true; }), 0)";

export function WhichProject({ id, question, projects, suggested, suggestedName, startText, reopenHref, action, hidden, withDay, primary }: {
  id: string; question: string; projects: readonly ProjectChoice[]; suggested?: string | null; suggestedName?: string; suggestedKind?: string;
  action: string; hidden?: Record<string, string>; withDay?: boolean; startText?: string; reopenHref?: string;
  /** 画面の主な操作にする時。入れる先が無く、始めるしか無い時だけ、始めるボタンを大きくする。 */
  primary?: boolean;
}) {
  const year = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  const ordered = [...projects].sort((a, b) => Number(b.project_id === suggested) - Number(a.project_id === suggested));
  const fields = Object.entries(hidden ?? {}).map(([name, value]) => <input type="hidden" name={name} value={value} />);
  return <div class="which-project">
    {ordered.length ? <form method="post" action={action} onsubmit={ONCE}>{fields}<input type="hidden" name="operation" value="assign" />
      <fieldset><legend>{question}</legend><div class="action-links">
        {ordered.map((project, index) => <button class={suggested && index === 0 ? undefined : "secondary"} name="projectId" value={project.project_id}>{project.name}</button>)}
      </div></fieldset>
    </form> : <p><b>準備中のものはありません。新しく準備を始めますか？</b></p>}
    <details class="none-of-these" open={!ordered.length || Boolean(suggestedName && !suggested)}><summary>{ordered.length ? "この中にない" : "新しく準備を始める"}</summary><div>
      <form method="post" action={action} onsubmit={ONCE}>{fields}<input type="hidden" name="operation" value="new-project" /><input type="hidden" name="year" value={String(year)} />
        {startText ? <p>{startText}</p> : null}
        {reopenHref ? <p class="link-line"><a href={reopenHref}>終わりを取り消す画面へ</a></p> : null}
        <div class="field"><label for={`${id}-name`}>新しく始めるものの名前</label><input id={`${id}-name`} name="projectName" type="text" maxlength={100} value={suggestedName ?? ""} required />{!startText ? <p class="help-text">名前だけで始めます。何の準備かは聞きません。去年の同じ予定や、一年の予定の並びがあれば、それを置きます。あとで直せます。</p> : null}</div>
        {withDay ? <div class="field"><label for={`${id}-day`}>当日（分かれば。あとでも直せます）</label><input id={`${id}-day`} name="eventDay" type="date" /></div> : null}
        <button class={primary && !ordered.length ? undefined : "secondary"}>この名前で新しく準備を始める</button>
      </form>
    </div></details>
  </div>;
}
