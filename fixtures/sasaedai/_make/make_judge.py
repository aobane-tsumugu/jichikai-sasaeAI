# -*- coding: utf-8 -*-
"""03_審査員が送る資料 を作る。デモ資料 25 点を送ったあとの自治会に、審査員が送って試すための 4 点。

- 年末の見回りの去年の記録（送ると、年末の見回りの資料として今の準備に入れられる）
- 去年の新年の集まりの案内（新しい行事）
- 春の清掃の班割り（新しい行事）
- 宅配のちらしの写真（関係のない物）

実行: python -X utf8 make_judge.py
"""
import datetime
import os
import random

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from PIL import ImageDraw

from common import (BASE, F_GOTH_B, F_GOTH_M, new_paper, para, photo, retime_zip, table, text,
                    text_width, utc_naive, write_docx)

D = datetime.datetime
OUT = os.path.join(BASE, "03_審査員が送る資料")


def p(name):
    return os.path.join(OUT, name)


def make_mimawari_kiroku(path, created, modified):
    """去年の年末の見回りが終わったあとに、役員が残した記録。"""
    body = []
    body.append(para("2025年度　年末の見回りの記録", align="center", bold=True, size=16, after=360))
    body.append(para("書いた人　副会長　佐藤 次郎", align="right", after=240))
    body.append(para("12月26日（金）から28日（日）まで、毎晩午後8時から、班ごとに町内を回りました。"))
    rows = [
        ["日", "回った班と人数", "天気と気づいたこと"],
        ["12月26日（金）", "1班 2人、2班 3人", "晴れ。2班の通りの街灯が一本消えていた（会長から市へ連絡済み）"],
        ["12月27日（土）", "3班 2人、4班 2人", "くもり。寒さが強く、手袋を忘れた人が多かった"],
        ["12月28日（日）", "5班 2人", "小雨。予定どおり回った。拍子木の数を確かめて倉庫へ戻した"],
    ]
    body.append(table(rows, [1900, 2500, 4600]))
    body.append(para("", after=120))
    body.append(para("来年への申し送り", bold=True, before=240))
    body.append(para("・申し込みが締切の直前に集まった。案内はもう少し早く回すとよい。"))
    body.append(para("・甘酒は二晩分で足りた。三晩目は温かいお茶だけでよかった。"))
    body.append(para("・拍子木は 6 組、腕章は 12 枚。28日に数を確かめて倉庫へ戻した。"))
    write_docx(path, "".join(body), title="年末の見回りの記録", creator="佐藤 次郎",
               created=created, modified=modified, font_name="游明朝")


def make_shinnen(path, created, modified):
    """去年の新年の集まりの案内。"""
    body = []
    body.append(para("ささえ台自治会　会員の皆さまへ"))
    body.append(para("ささえ台自治会　会長　山田 一郎", align="right", after=360))
    body.append(para("新年の集まりのご案内", align="center", bold=True, size=16, after=360))
    body.append(para("新しい年を迎え、ささえ台の皆さまと顔を合わせる集まりを開きます。"
                     "転入されたばかりの方も、お子さん連れの方も、どうぞお気軽にお越しください。", after=240))
    body.append(para("記", align="center", after=200))
    rows = [
        ["日時", "2026年1月11日（日）　午前11時から午後1時まで"],
        ["場所", "ささえ台集会所　ホール"],
        ["内容", "会長のあいさつ、おしるこ、子ども向けの書き初め、福引き"],
        ["会費", "大人500円、中学生以下は無料"],
        ["申し込み", "12月20日（土）までに、班長へ人数をお伝えください"],
        ["問い合わせ", "会長　山田 一郎　090-0000-0001"],
    ]
    body.append(table(rows, [1900, 7100]))
    body.append(para("以上", align="right", before=240))
    write_docx(path, "".join(body), title="新年の集まりのご案内", creator="山田 一郎",
               created=created, modified=modified, font_name="游明朝")


SEISOU = [
    ("1班", "佐藤、田中、木村", "集会所のまわりと花壇", "竹ぼうき、ごみ袋"),
    ("2班", "鈴木、渡辺、小林", "1丁目の側溝", "スコップ、土のう袋"),
    ("3班", "高橋、伊藤、松本", "2丁目の側溝と公園", "スコップ、軍手"),
    ("4班", "加藤、吉田、井上", "ごみ置き場と掲示板のまわり", "デッキブラシ、バケツ"),
    ("5班", "山本、中村、林", "用水路の草刈り", "草刈り鎌、ごみ袋"),
]


def make_seisou(path, created, modified):
    """春の清掃の班割り。"""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "春の清掃"
    thin = Side(style="thin", color="666666")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    ws["A1"] = "2025年度　春の清掃　班割り（5月18日（日）午前8時から）"
    ws["A1"].font = Font(name="游ゴシック", size=14, bold=True)
    ws.merge_cells("A1:D1")
    head = ["班", "主に出る世帯", "受け持ち", "持ち物"]
    for c, v in enumerate(head, start=1):
        cell = ws.cell(row=2, column=c, value=v)
        cell.font = Font(name="游ゴシック", size=11, bold=True)
        cell.fill = PatternFill("solid", fgColor="E2EFDA")
        cell.border = border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for r, row in enumerate(SEISOU, start=3):
        for c, v in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = Font(name="游ゴシック", size=11)
            cell.border = border
            cell.alignment = Alignment(vertical="center", horizontal="center" if c == 1 else "left")
    last = 3 + len(SEISOU) + 1
    notes = ["集まった草とごみは、9時半までに集会所の前へ。市の回収は翌日の朝です。",
             "雨の時は、5月25日（日）に延ばします（班長から連絡）。"]
    for i, note in enumerate(notes):
        ws.cell(row=last + i, column=1, value=note).font = Font(name="游ゴシック", size=11)
        ws.merge_cells(start_row=last + i, start_column=1, end_row=last + i, end_column=4)
    for col, w in zip("ABCD", [8, 22, 28, 22]):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[1].height = 24
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    wb.properties.creator = "田中 三郎"
    wb.properties.lastModifiedBy = "田中 三郎"
    wb.properties.title = "春の清掃 班割り"
    wb.properties.created = utc_naive(created)
    wb.properties.modified = utc_naive(modified)
    wb.save(path)
    retime_zip(path, modified)


def make_pizza(out_path):
    """宅配のちらし（自治会と関係のない物）を机に置いて撮った写真。"""
    W, H = 1240, 1754
    img = new_paper(W, H, (255, 252, 244))
    d = ImageDraw.Draw(img)
    red = (196, 46, 36)
    d.rectangle([0, 0, W, 300], fill=red)
    title = "ピッツァ　ささの葉"
    text(d, ((W - text_width(title, 92, F_GOTH_B)) // 2, 70), title, 92, F_GOTH_B, fill=(255, 255, 255))
    sub = "宅配メニュー　お電話一本でお届けします"
    text(d, ((W - text_width(sub, 40, F_GOTH_M)) // 2, 200), sub, 40, F_GOTH_M, fill=(255, 240, 220))
    items = [("マルゲリータ", "1,380円"), ("照り焼きチキン", "1,580円"), ("きのこと野菜", "1,480円"),
             ("4種のチーズ", "1,680円"), ("ポテトとベーコン", "1,480円"), ("フライドポテト", "480円")]
    rng = random.Random(7077)
    for k, (name, price) in enumerate(items):
        y = 380 + k * 170
        x0 = 90
        d.rounded_rectangle([x0, y, W - 90, y + 140], radius=24, fill=(255, 236, 214), outline=(230, 190, 150), width=3)
        d.ellipse([x0 + 24, y + 18, x0 + 128, y + 122], fill=(230, 160 + rng.randint(-20, 20), 70), outline=(180, 110, 50), width=4)
        text(d, (x0 + 160, y + 40), name, 52, F_GOTH_B, fill=(60, 30, 20))
        text(d, (W - 90 - 40 - text_width(price, 52, F_GOTH_B), y + 40), price, 52, F_GOTH_B, fill=red)
    foot = "11時から21時まで　火曜休み　電話 000-0000-0000"
    text(d, ((W - text_width(foot, 38, F_GOTH_M)) // 2, H - 150), foot, 38, F_GOTH_M, fill=(80, 60, 50))
    photo(img, out_path, seed=7078, desk="wood", fill=0.8, angle=4.0, keystone=0.03, offset=(-30, 40))


def main():
    os.makedirs(OUT, exist_ok=True)
    make_mimawari_kiroku(p("2025年度_年末の見回りの記録.docx"),
                         created=D(2025, 12, 29, 10, 20), modified=D(2025, 12, 29, 11, 5))
    make_shinnen(p("2025年度_新年の集まりのご案内.docx"),
                 created=D(2025, 12, 5, 20, 0), modified=D(2025, 12, 5, 20, 40))
    make_seisou(p("2025年度_春の清掃の班割り.xlsx"),
                created=D(2025, 5, 2, 19, 30), modified=D(2025, 5, 2, 20, 0))
    make_pizza(p("宅配ピザのちらし.jpg"))


if __name__ == "__main__":
    main()
