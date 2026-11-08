import { ITEM_SCREEN_LABEL } from "../../project/model";
import { PrintDocument } from "../a4";
import { qrSvg } from "../qr";

import { POSTER_CSS } from "../../core/styles";
import { publishedItem } from "../content";


export function PosterPage({ wardName, title, body, wardUrl, withAnswer, due, contact, distributed, back, copies, generalMeeting = false }: { wardName?: string; withAnswer: boolean; generalMeeting?: boolean; title: string; body: string; wardUrl: string; due?: string; contact?: string; distributed?: string; back?: string; copies?: string }) {
  const dateTime = publishedItem(body, "date_time");
  const place = publishedItem(body, "place");
  // 雨の時の場所を載せないと、掲示を見た人が雨の日に元の場所へ行く
  const rainPlan = publishedItem(body, "rain_plan");
  return <PrintDocument title={`${title}貼れる一枚`} back={back} copies={copies} hint="一枚の部分を撮って掲示や転送に使えます。印刷するときはA4、倍率100%、ヘッダーとフッターなしにしてください。">
    <style dangerouslySetInnerHTML={{ __html: POSTER_CSS }} />
    <section class="sheet poster" aria-label="貼れる一枚">
      <h1>{title}</h1>
      {dateTime || place || rainPlan ? <dl>
        {dateTime ? <><dt>{ITEM_SCREEN_LABEL.date_time}</dt><dd>{dateTime}</dd></> : null}
        {place ? <><dt>{ITEM_SCREEN_LABEL.place}</dt><dd>{place}</dd></> : null}
        {rainPlan ? <><dt>{ITEM_SCREEN_LABEL.rain_plan}</dt><dd>{rainPlan}</dd></> : null}
      </dl> : null}
      {withAnswer && due ? <><p>返事の締切：{due}</p><p>{generalMeeting ? "出席、委任、欠席のどれかを答えてください。" : "参加しないときも、返事をもらえると、準備の数が正しく分かります。返事がないときは、欠席として数えます。"}</p></> : null}
      {contact ? <p>連絡先：{contact}</p> : null}
      <div class="poster-link">
        <div class="poster-qr" role="img" aria-label="住民向けのページを開くQR" dangerouslySetInnerHTML={{ __html: qrSvg(wardUrl) }} />
        <a class="poster-url" href={wardUrl}>{wardUrl}</a>
        <p>スマホのカメラを向けて、出てきた文字を押してください。</p>
      </div>
      <div class="sheet-footer"><span>{wardName}</span><span>{distributed}</span></div>
    </section>
  </PrintDocument>;
}
