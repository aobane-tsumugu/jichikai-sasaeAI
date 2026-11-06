import { ITEM_LABEL } from "../../project/model";
import { PrintDocument } from "../a4";
import { qrSvg } from "../qr";

const POSTER_CSS = `
.sheet.poster { min-height:296mm; display:flex; flex-direction:column; justify-content:space-around; gap:8mm; text-align:center; padding:18mm 16mm; }
.poster h1 { margin:0; font-size:30pt; line-height:1.4; overflow-wrap:anywhere; }
.poster dl { margin:0; width:100%; }
.poster dt { margin:5mm 0 1mm; font-size:13pt; }
.poster dd { margin:0; font-size:22pt; font-weight:bold; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.poster-link { width:100%; }
.poster-qr { width:70mm; max-width:55%; margin:0 auto; }
.poster-qr svg { display:block; width:100%; height:auto; }
.poster-url { display:block; margin-top:3mm; color:#000; font-size:10pt; overflow-wrap:anywhere; }
@media screen and (max-width:215mm) {
  .sheet.poster { width:100%; min-height:0; aspect-ratio:210 / 296; margin:0 auto; padding:6%; gap:4vw; }
  .poster h1 { font-size:clamp(24px,7vw,40px); }
  .poster dt { margin:3vw 0 1vw; font-size:14px; }
  .poster dd { font-size:clamp(18px,5vw,28px); }
  .poster-qr { width:48%; max-width:70mm; }
  .poster-url { font-size:11px; }
}
`;

/** 日時・場所は配った本文の項目だけを使い、現在の状態や下書きから補わない。 */
function publishedItem(body: string, key: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !("items" in parsed) || !Array.isArray(parsed.items)) return null;
  for (const item of parsed.items) {
    if (item && typeof item === "object" && item.key === key && typeof item.content === "string" && item.content.trim()) return item.content;
  }
  return null;
}

export function PosterPage({ title, body, wardUrl }: { title: string; body: string; wardUrl: string }) {
  const dateTime = publishedItem(body, "date_time");
  const place = publishedItem(body, "place");
  // 雨の時の場所を載せないと、掲示を見た人が雨の日に元の場所へ行く
  const rainPlan = publishedItem(body, "rain_plan");
  return <PrintDocument title={`${title} 貼れる一枚`} hint="一枚の部分を撮って掲示や転送に使えます。印刷する時は A4、倍率100%、ヘッダーとフッターなしにしてください。">
    <style dangerouslySetInnerHTML={{ __html: POSTER_CSS }} />
    <section class="sheet poster" aria-label="貼れる一枚">
      <h1>{title}</h1>
      {dateTime || place || rainPlan ? <dl>
        {dateTime ? <><dt>{ITEM_LABEL.date_time}</dt><dd>{dateTime}</dd></> : null}
        {place ? <><dt>{ITEM_LABEL.place}</dt><dd>{place}</dd></> : null}
        {rainPlan ? <><dt>{ITEM_LABEL.rain_plan}</dt><dd>{rainPlan}</dd></> : null}
      </dl> : null}
      <div class="poster-link">
        <div class="poster-qr" role="img" aria-label="区のページを開く QR" dangerouslySetInnerHTML={{ __html: qrSvg(wardUrl) }} />
        <a class="poster-url" href={wardUrl}>{wardUrl}</a>
      </div>
    </section>
  </PrintDocument>;
}
