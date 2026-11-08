# -*- coding: utf-8 -*-
"""01_関係する資料 を作る。新任の役員が引き継ぎで受け取った物と、中身が少しだけ違う三組。

実行: python -X utf8 make_related.py
"""
import datetime
import os
import random

import fitz
import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from PIL import Image, ImageDraw

from common import (DIR_REL, F_GOTH_B, F_GOTH_M, F_MIN, F_UDG, crease, font, hand_arrow,
                    hand_check, hand_ellipse, hand_line, hand_rect, handwrite, new_paper,
                    para, pdf_date, photo, retime_zip, ruled_paper, run, set_mtime, table,
                    text, text_width, utc_naive, wrap_ja, write_docx)

D = datetime.datetime
OUT = DIR_REL


def p(name):
    return os.path.join(OUT, name)


# ---------------------------------------------------------------------------
# 1. 秋の収穫祭のご案内（組 1: 締切と抽選会の有無だけが違う二つの版）
# ---------------------------------------------------------------------------

def make_annai(path, deadline, with_lottery, created, modified):
    naiyou = "豚汁のふるまい\n子どもの野菜すくい"
    if with_lottery:
        naiyou += "\n抽選会（12時半から）"
    body = []
    body.append(para("ささえ台自治会　会員の皆さまへ"))
    body.append(para("ささえ台自治会　会長　山田 一郎", align="right", after=360))
    body.append(para("秋の収穫祭のご案内", align="center", bold=True, size=16, after=360))
    body.append(para("朝夕すずしくなってまいりました。皆さまいかがお過ごしでしょうか。", indent=0))
    body.append(para("今年も、ささえ台の秋の収穫祭を開きます。地元でとれた野菜を使った豚汁のふるまいなどを用意しています。"
                     "ご家族おそろいで、お気軽にお越しください。", after=240))
    body.append(para("記", align="center", after=200))
    rows = [
        ["日時", "2025年10月19日（日）　10時から14時まで"],
        ["場所", "ささえ台集会所の広場\n雨の時は集会所の中で行います"],
        ["内容", naiyou],
        ["参加の返事", "{}までに、回答票を班長へお渡しください".format(deadline)],
        ["持ち物", "豚汁のおわんとおはし（お持ちの方）"],
        ["連絡先", "会長　山田 一郎　090-0000-0001"],
    ]
    body.append(table(rows, [1900, 7100]))
    body.append(para("", after=120))
    body.append(para("当日のお手伝いの係は、回答票の「手伝える係」をもとに、後日お知らせします。", size=10))
    body.append(para("以上", align="right", before=240))
    write_docx(path, "".join(body), title="秋の収穫祭のご案内", creator="山田 一郎",
               created=created, modified=modified, font_name="游明朝")


# ---------------------------------------------------------------------------
# 2. 秋の収穫祭の当番表（組 2: 豚汁と片付けの世帯を二つ入れ替えた版）
# ---------------------------------------------------------------------------

TOUBAN = [
    ("受付", "9:30〜12:00", "1班", "佐藤", "回答票の名簿を持つ"),
    ("受付", "9:30〜12:00", "1班", "田中", ""),
    ("豚汁", "8:00〜13:00", "2班", "鈴木", "材料の買い出しは前日"),
    ("豚汁", "8:00〜13:00", "2班", "渡辺", ""),
    ("豚汁", "8:00〜13:00", "2班", "小林", ""),
    ("野菜すくい", "9:30〜12:30", "3班", "高橋", "野菜は当日の朝に受け取る"),
    ("野菜すくい", "9:30〜12:30", "3班", "伊藤", ""),
    ("抽選会", "12:00〜14:00", "4班", "加藤", "景品は前日に集会所へ"),
    ("抽選会", "12:00〜14:00", "4班", "吉田", ""),
    ("片付け", "13:30〜15:00", "5班", "山本", "テントは集会所の倉庫へ"),
    ("片付け", "13:30〜15:00", "5班", "中村", ""),
]


def make_touban(path, swap, created, modified):
    rows = [list(r) for r in TOUBAN]
    if swap:
        # 豚汁の小林（2班）と片付けの中村（5班）を入れ替える
        a = [i for i, r in enumerate(rows) if r[3] == "小林"][0]
        b = [i for i, r in enumerate(rows) if r[3] == "中村"][0]
        rows[a][2], rows[a][3], rows[b][2], rows[b][3] = rows[b][2], rows[b][3], rows[a][2], rows[a][3]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "当番表"
    thin = Side(style="thin", color="666666")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    f_title = Font(name="游ゴシック", size=14, bold=True)
    f_head = Font(name="游ゴシック", size=11, bold=True)
    f_body = Font(name="游ゴシック", size=11)
    ws["A1"] = "2025年度　秋の収穫祭　当番表（10月19日（日））"
    ws["A1"].font = f_title
    ws.merge_cells("A1:E1")
    head = ["係", "時間", "班", "担当の世帯", "備考"]
    for c, v in enumerate(head, start=1):
        cell = ws.cell(row=2, column=c, value=v)
        cell.font = f_head
        cell.fill = PatternFill("solid", fgColor="DDEBF7")
        cell.border = border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for r, row in enumerate(rows, start=3):
        for c, v in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = f_body
            cell.border = border
            cell.alignment = Alignment(vertical="center", horizontal="center" if c in (2, 3) else "left")
    last = 3 + len(rows) + 1
    ws.cell(row=last, column=1, value="雨の時は集会所の中で同じ係").font = Font(name="游ゴシック", size=11, bold=True)
    ws.merge_cells(start_row=last, start_column=1, end_row=last, end_column=5)
    for col, w in zip("ABCDE", [14, 14, 8, 16, 30]):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[1].height = 24
    ws.page_setup.orientation = "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4

    wb.properties.creator = "山田 一郎"
    wb.properties.lastModifiedBy = "山田 一郎"
    wb.properties.title = "秋の収穫祭 当番表"
    wb.properties.created = utc_naive(created)
    wb.properties.modified = utc_naive(modified)
    wb.save(path)
    retime_zip(path, modified)


# ---------------------------------------------------------------------------
# 3. 回答票（PDF）と 4. 記入済みを撮った写真
# ---------------------------------------------------------------------------

def make_kaitou_pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # 本文は BIZ UDゴシック（游ゴシックだと取り出した字の空白とハイフンが別の字になるため）
    page.insert_font(fontname="GM", fontfile=F_UDG)
    page.insert_font(fontname="GB", fontfile=F_GOTH_B)
    fm = fitz.Font(fontfile=F_UDG)
    fb = fitz.Font(fontfile=F_GOTH_B)
    pos = {}
    x0, x1, x2 = 60, 180, 535

    page.draw_rect(fitz.Rect(x0, 48, x2, 108), color=(0, 0, 0), width=1.2)
    page.insert_text((75, 72), "返事の締切　10月5日（日）", fontname="GB", fontsize=14)
    page.insert_text((75, 97), "返す先　　　お住まいの班の班長", fontname="GM", fontsize=12)

    title = "2025年度　秋の収穫祭　参加の回答票"
    tw = fb.text_length(title, fontsize=20)
    page.insert_text(((595 - tw) / 2, 160), title, fontname="GB", fontsize=20)
    sub = "ささえ台自治会"
    page.insert_text((x2 - fm.text_length(sub, fontsize=11), 188), sub, fontname="GM", fontsize=11)

    heights = [("世帯のお名前", 70), ("班", 55), ("参加", 55), ("人数", 55), ("手伝える係", 80), ("ひとこと", 110)]
    y = 205
    tops = {}
    for label, h in heights:
        page.draw_rect(fitz.Rect(x0, y, x1, y + h), color=(0, 0, 0), width=0.8, fill=(0.93, 0.93, 0.93))
        page.draw_rect(fitz.Rect(x1, y, x2, y + h), color=(0, 0, 0), width=0.8)
        lw = fb.text_length(label, fontsize=13)
        page.insert_text((x0 + (x1 - x0 - lw) / 2, y + h / 2 + 5), label, fontname="GB", fontsize=13)
        tops[label] = (y, h)
        y += h
    table_bottom = y

    # 世帯のお名前
    t, h = tops["世帯のお名前"]
    page.insert_text((x1 + 8, t + 14), "（代表の方のお名前）", fontname="GM", fontsize=8, color=(0.4, 0.4, 0.4))
    pos["name"] = (x1 + 30, t + 22)
    # 班
    t, h = tops["班"]
    page.insert_text((x1 + 110, t + h / 2 + 5), "班", fontname="GM", fontsize=13)
    pos["han"] = (x1 + 60, t + 10)
    # 参加
    t, h = tops["参加"]
    sx = x1 + 20
    page.insert_text((sx, t + h / 2 + 5), "参加する", fontname="GM", fontsize=13)
    w1 = fm.text_length("参加する", fontsize=13)
    pos["sanka"] = (sx - 10, t + 9, sx + w1 + 10, t + h - 9)
    page.insert_text((sx + w1 + 22, t + h / 2 + 5), "・", fontname="GM", fontsize=13)
    sx2 = sx + w1 + 50
    page.insert_text((sx2, t + h / 2 + 5), "参加しない", fontname="GM", fontsize=13)
    page.insert_text((sx2 + fm.text_length("参加しない", fontsize=13) + 18, t + h / 2 + 5),
                     "（どちらかに○）", fontname="GM", fontsize=10, color=(0.3, 0.3, 0.3))
    # 人数
    t, h = tops["人数"]
    bx = x1 + 20
    page.insert_text((bx, t + h / 2 + 5), "大人", fontname="GM", fontsize=13)
    page.insert_text((bx + 100, t + h / 2 + 5), "人", fontname="GM", fontsize=13)
    pos["otona"] = (bx + 55, t + 9)
    page.insert_text((bx + 160, t + h / 2 + 5), "子ども", fontname="GM", fontsize=13)
    page.insert_text((bx + 275, t + h / 2 + 5), "人", fontname="GM", fontsize=13)
    pos["kodomo"] = (bx + 230, t + 9)
    # 手伝える係
    t, h = tops["手伝える係"]
    items = [["受付", "豚汁", "野菜すくい"], ["抽選会", "片付け"]]
    pos["kakari"] = {}
    for li, line in enumerate(items):
        cx = x1 + 20
        by = t + 18 + li * 32
        for it in line:
            page.draw_rect(fitz.Rect(cx, by, cx + 13, by + 13), color=(0, 0, 0), width=0.9)
            pos["kakari"][it] = (cx, by)
            page.insert_text((cx + 19, by + 12), it, fontname="GM", fontsize=13)
            cx += 19 + fm.text_length(it, fontsize=13) + 30
        if li == 1:
            page.insert_text((cx + 10, by + 12), "（いくつでも）", fontname="GM", fontsize=10, color=(0.3, 0.3, 0.3))

    page.insert_text((x0, table_bottom + 32), "当日の係は、いただいた回答票をもとに、後日お知らせします。", fontname="GM", fontsize=11)
    page.insert_text((x0, table_bottom + 56), "お問い合わせ　会長　山田 一郎　090-0000-0001", fontname="GM", fontsize=11)

    doc.set_metadata({"title": "秋の収穫祭 参加の回答票", "author": "山田 一郎", "creator": "", "producer": "",
                      "creationDate": pdf_date(D(2025, 9, 20, 20, 30)), "modDate": pdf_date(D(2025, 9, 20, 20, 30))})
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)
    doc.close()
    return pos


def make_kaitou_photo(pdf_path, pos, out_path):
    doc = fitz.open(pdf_path)
    dpi = 200
    pix = doc[0].get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()
    s = dpi / 72.0
    rng = random.Random(404)
    ink = (25, 30, 80)
    d = ImageDraw.Draw(img)
    nx, ny = pos["name"]
    handwrite(img, nx * s, ny * s, "鈴木　花子", 30 * s, rng, path=F_GOTH_M, color=ink, jit_size=0.14,
              jit_rot=7, spacing=1.02, slope=-0.01, stroke=1)
    hx, hy = pos["han"]
    handwrite(img, hx * s, hy * s, "2", 30 * s, rng, color=ink, stroke=1)
    x0, y0, x1, y1 = pos["sanka"]
    hand_ellipse(d, (x0 * s, y0 * s, x1 * s, y1 * s), rng, width=5, fill=ink)
    ox, oy = pos["otona"]
    handwrite(img, ox * s, oy * s, "2", 28 * s, rng, color=ink, stroke=1)
    kx, ky = pos["kodomo"]
    handwrite(img, kx * s, ky * s, "1", 28 * s, rng, color=ink, stroke=1)
    cx, cy = pos["kakari"]["豚汁"]
    hand_check(d, (cx - 3) * s, (cy - 8) * s, 20 * s, rng, width=6, fill=ink)
    img = crease(img, img.size[1] // 3, strength=10)
    img = crease(img, img.size[1] * 2 // 3, strength=8)
    photo(img, out_path, seed=4041, desk="wood", fill=0.86, angle=-2.2, keystone=0.03, hand_shadow=True)


# ---------------------------------------------------------------------------
# 5. 規約（PDF）
# ---------------------------------------------------------------------------

KIYAKU = [
    ("名称", "第1条　この会は、ささえ台自治会（以下「本会」という。）と称する。"),
    ("目的", "第2条　本会は、会員がたがいに助け合い、住みよい地域をつくることを目的とする。"),
    ("区域", "第3条　本会の区域は、ささえ台の1班から5班までとする。"),
    ("会員", "第4条　本会の区域に住む世帯で、本会の目的に賛成するものを会員とする。\n2　入会と退会は、班長を通じて会長に申し出る。"),
    ("役員", "第5条　本会に、次の役員を置く。\n(1)　会長　1名\n(2)　副会長　1名\n(3)　会計　1名\n(4)　書記　1名\n(5)　班長　各班1名\n(6)　監事　1名"),
    ("役員の選び方と任期", "第6条　役員は、総会で選ぶ。\n2　役員の任期は1年とし、再任を妨げない。"),
    ("総会", "第7条　総会は、毎年4月に開く。会長が必要と認めた時は、臨時の総会を開くことができる。\n"
             "2　総会は、会員の半数以上の出席（委任状を含む）で成り立ち、出席した会員の過半数で決める。\n"
             "3　総会では、事業の報告と計画、決算と予算、役員の選出、そのほかの大事なことを決める。"),
    ("役員会", "第8条　役員会は会長が開き、総会で決めたことを進めるための話し合いをする。"),
    ("会費", "第9条　会費は、1世帯につき年6000円とする。\n2　会費は班長が集め、会計に渡す。"),
    ("会計年度", "第10条　本会の会計年度は、毎年4月1日から翌年3月31日までとする。"),
    ("会計の報告", "第11条　会計は、毎年の総会で決算を報告する。決算は、総会の前に監事の監査を受ける。"),
    ("規約の改正", "第12条　この規約は、総会の議決によって改めることができる。"),
]


def make_kiyaku(path):
    doc = fitz.open()
    fm = fitz.Font(fontfile=F_MIN)
    fg = fitz.Font(fontfile=F_GOTH_M)
    X0, X1 = 72, 523
    width = X1 - X0
    size = 11
    lh = size * 1.75
    state = {"page": None, "y": 0}

    def newpage():
        pg = doc.new_page(width=595, height=842)
        pg.insert_font(fontname="MI", fontfile=F_MIN)
        pg.insert_font(fontname="GM", fontfile=F_GOTH_M)
        state["page"] = pg
        state["y"] = 80

    def need(h):
        if state["page"] is None or state["y"] + h > 780:
            newpage()

    newpage()
    pg = state["page"]
    title = "ささえ台自治会規約"
    tw = fm.text_length(title, fontsize=18)
    pg.insert_text(((595 - tw) / 2, 100), title, fontname="MI", fontsize=18)
    state["y"] = 140
    for head, bodytext in KIYAKU:
        need(lh * 2.5)
        state["page"].insert_text((X0 + size, state["y"]), "（{}）".format(head), fontname="GM", fontsize=size)
        state["y"] += lh
        for i, paragraph in enumerate(bodytext.split("\n")):
            hang = size if i == 0 else size * 1.0
            indent0 = 0 if (i == 0 or not paragraph.startswith("(")) else size
            lines = wrap_ja(paragraph, fm, size, width - hang - indent0, first_width=width - indent0)
            for j, ln in enumerate(lines):
                need(lh)
                x = X0 + indent0 + (0 if j == 0 else hang)
                state["page"].insert_text((x, state["y"]), ln, fontname="MI", fontsize=size)
                state["y"] += lh
        state["y"] += lh * 0.4
    need(lh * 4)
    state["y"] += lh * 0.6
    state["page"].insert_text((X0 + size * 3, state["y"]), "附　則", fontname="GM", fontsize=size)
    state["y"] += lh
    state["page"].insert_text((X0 + size, state["y"]), "この規約は、2019年4月1日から施行する。", fontname="MI", fontsize=size)
    state["y"] += lh
    state["page"].insert_text((X0 + size, state["y"]), "2024年4月21日　一部改正", fontname="MI", fontsize=size)

    for i, pg in enumerate(doc):
        label = "- {} -".format(i + 1)
        pg.insert_text(((595 - fm.text_length(label, fontsize=9)) / 2, 815), label, fontname="MI", fontsize=9)

    doc.set_metadata({"title": "ささえ台自治会規約", "author": "ささえ台自治会", "creator": "", "producer": "",
                      "creationDate": pdf_date(D(2024, 4, 25, 21, 0)), "modDate": pdf_date(D(2024, 4, 25, 21, 0))})
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)
    doc.close()


# ---------------------------------------------------------------------------
# 6. 年間の予定（紙の表を撮った形）
# ---------------------------------------------------------------------------

def make_nenkan(out_path):
    W, H = 1654, 2339
    img = new_paper(W, H)
    d = ImageDraw.Draw(img)
    title = "2026年度　ささえ台自治会　年間の予定"
    tw = text_width(title, 64, F_GOTH_B)
    text(d, ((W - tw) / 2, 150), title, 64, F_GOTH_B)
    text(d, (W - 160 - text_width("ささえ台自治会 役員会", 34), 260), "ささえ台自治会 役員会", 34, F_GOTH_M)
    rows = [("4月", "総会"), ("5月", "春の清掃"), ("6月", ""), ("7月", "夏祭りの話し合い"), ("8月", "夏祭り"),
            ("9月", ""), ("10月", "秋の収穫祭"), ("11月", ""), ("12月", "年末の見回り"), ("1月", "新年会"),
            ("2月", ""), ("3月", "役員の引き継ぎ")]
    x0, x1, x2 = 160, 400, W - 160
    y = 350
    rh = 118
    d.rectangle([x0, y, x2, y + 80], fill=(225, 225, 225))
    text(d, ((x0 + x1) / 2, y + 40), "月", 40, F_GOTH_B, anchor="mm")
    text(d, ((x1 + x2) / 2, y + 40), "行事", 40, F_GOTH_B, anchor="mm")
    d.rectangle([x0, y, x2, y + 80], outline=(30, 30, 30), width=3)
    y += 80
    for m, ev in rows:
        d.rectangle([x0, y, x1, y + rh], outline=(30, 30, 30), width=3)
        d.rectangle([x1, y, x2, y + rh], outline=(30, 30, 30), width=3)
        text(d, ((x0 + x1) / 2, y + rh / 2), m, 44, F_GOTH_M, anchor="mm")
        if ev:
            text(d, (x1 + 50, y + rh / 2), ev, 46, F_GOTH_M, anchor="lm")
        y += rh
    y += 60
    d.rectangle([x0, y, x2, y + 230], outline=(30, 30, 30), width=3)
    text(d, (x0 + 40, y + 30), "毎週・毎月のこと", 40, F_GOTH_B)
    text(d, (x0 + 60, y + 100), "毎週月曜　ごみ当番", 42, F_GOTH_M)
    text(d, (x0 + 60, y + 160), "毎月　　　市報と回覧の配布", 42, F_GOTH_M)
    img = crease(img, H // 2, strength=12)
    photo(img, out_path, seed=606, desk="gray", fill=0.87, angle=1.6, keystone=0.035, curl=0.05)


# ---------------------------------------------------------------------------
# 7. 役員会のメモ（組 3: 収穫祭の日だけが違う二枚）
# ---------------------------------------------------------------------------

def make_memo(out_path, fest_day, exif_dt, photo_seed, angle, desk):
    W, H = 1500, 2100
    rng = random.Random(707)  # 二枚とも同じ書き方（違いは日付の字だけ）
    gap = 92
    top = 230
    img = ruled_paper(W, H, rng, line_gap=gap, top=top, margin_left=130)
    d = ImageDraw.Draw(img)
    ink = (22, 26, 48)
    lines = [
        (0, "4月　役員会", 62, True),
        (2, "決まったこと", 54, True),
        (3, "・秋の収穫祭　10月{}日（日）".format(fest_day), 54, False),
        (4, "・予算は去年と同じ　8万円", 54, False),
        (5, "・豚汁の係は　3班", 54, False),
        (6, "・抽選会の景品　20個", 54, False),
        (8, "まだ決まっていないこと", 54, True),
        (9, "・雨の時に集会所が使えるか", 54, False),
        (10, "　確かめる", 54, False),
    ]
    for li, s, size, under in lines:
        y = top + gap * li - size - 14 + (gap if li == 0 else 0) - (gap if li == 0 else 0)
        x = 170 + rng.uniform(-6, 6)
        if li == 0:
            y = top - size - 30
        end = handwrite(img, x, y, s, size, rng, path=F_GOTH_M, color=ink, jit_size=0.12, jit_rot=6,
                        spacing=0.98, slope=rng.uniform(-0.004, 0.002), stroke=1)
        if under:
            hand_line(d, (x - 5, y + size + 22), (end + 10, y + size + 18 + rng.uniform(-6, 6)), rng, width=4, fill=ink)
    photo(img, out_path, seed=photo_seed, desk=desk, fill=0.86, angle=angle, exif_datetime=exif_dt)
    dt = datetime.datetime.strptime(exif_dt, "%Y:%m:%d %H:%M:%S")
    set_mtime(out_path, dt)


# ---------------------------------------------------------------------------
# 8. 市からの依頼（PDF）
# ---------------------------------------------------------------------------

def make_shi(path):
    doc = fitz.open()
    fm = fitz.Font(fontfile=F_MIN)
    fg = fitz.Font(fontfile=F_GOTH_B)
    X0, X1 = 72, 523
    size = 11
    lh = size * 1.8

    pg = doc.new_page(width=595, height=842)
    pg.insert_font(fontname="MI", fontfile=F_MIN)
    pg.insert_font(fontname="GB", fontfile=F_GOTH_B)

    def right(s, y, sz=size):
        pg.insert_text((X1 - fm.text_length(s, fontsize=sz), y), s, fontname="MI", fontsize=sz)

    right("市危第58号", 80)
    right("2026年7月1日", 80 + lh)
    pg.insert_text((X0, 80 + lh * 3), "各自治会長　様", fontname="MI", fontsize=size)
    right("市　危機管理課", 80 + lh * 4)
    t = "防災訓練の参加予定人数のご報告について（お願い）"
    pg.insert_text(((595 - fg.text_length(t, fontsize=14)) / 2, 80 + lh * 6.2), t, fontname="GB", fontsize=14)
    y = 80 + lh * 8
    for para_text in ["日ごろから、市の防災の取り組みにご協力をいただき、ありがとうございます。",
                      "今年も、9月に市の防災訓練を行います。準備のため、各自治会の参加予定の人数を、下記のとおりご報告くださいますよう、お願いいたします。"]:
        for ln in wrap_ja("　" + para_text, fm, size, X1 - X0):
            pg.insert_text((X0, y), ln, fontname="MI", fontsize=size)
            y += lh
    y += lh * 0.5
    pg.insert_text(((595 - fm.text_length("記", fontsize=size)) / 2, y), "記", fontname="MI", fontsize=size)
    y += lh * 1.3
    items = [
        ("1　訓練の日時", "2026年9月6日（日）　午前9時から11時まで（雨の時も行います）"),
        ("2　訓練の内容", "各自治会の集合場所に集まり、指定の避難所まで歩いて避難します。避難所では、消火器と給水の体験をします。"),
        ("3　報告すること", "自治会の名前、参加予定の人数（大人と子ども）、当日の連絡を受ける方のお名前と電話番号"),
        ("4　報告の締切", "2026年8月29日（土）"),
        ("5　報告の方法", "別紙の報告書に書いて、危機管理課の窓口に出すか、メールで送ってください。\nメール　bosai@example.com"),
        ("6　問い合わせ", "市　危機管理課　防災係　電話　090-0000-0100"),
    ]
    lab_w = 120
    for lab, val in items:
        pg.insert_text((X0, y), lab, fontname="MI", fontsize=size)
        for k, ln in enumerate(wrap_ja(val, fm, size, X1 - X0 - lab_w)):
            pg.insert_text((X0 + lab_w, y), ln, fontname="MI", fontsize=size)
            y += lh
        y += lh * 0.3
    y += lh * 0.5
    right("以上", y)

    # 別紙
    pg2 = doc.new_page(width=595, height=842)
    pg2.insert_font(fontname="MI", fontfile=F_MIN)
    pg2.insert_font(fontname="GB", fontfile=F_GOTH_B)
    pg2.insert_text((X0, 80), "別紙", fontname="MI", fontsize=size)
    t = "防災訓練　参加予定人数の報告書"
    pg2.insert_text(((595 - fg.text_length(t, fontsize=16)) / 2, 130), t, fontname="GB", fontsize=16)
    pg2.insert_text((X0, 170), "報告の締切　2026年8月29日（土）", fontname="MI", fontsize=size)
    rows = [("自治会の名前", 60), ("参加予定の人数", 90), ("当日の連絡を受ける方\nのお名前", 60), ("電話番号", 50), ("そのほか\n（気になること）", 120)]
    y = 195
    cx = X0 + 150
    for lab, h in rows:
        pg2.draw_rect(fitz.Rect(X0, y, cx, y + h), color=(0, 0, 0), width=0.8, fill=(0.94, 0.94, 0.94))
        pg2.draw_rect(fitz.Rect(cx, y, X1, y + h), color=(0, 0, 0), width=0.8)
        labl = lab.split("\n")
        for i, l in enumerate(labl):
            pg2.insert_text((X0 + 10, y + h / 2 + 4 - (len(labl) - 1) * 8 + i * 16), l, fontname="MI", fontsize=size)
        if lab == "参加予定の人数":
            pg2.insert_text((cx + 20, y + 30), "大人　　　　　　人", fontname="MI", fontsize=size)
            pg2.insert_text((cx + 20, y + 55), "子ども　　　　　人", fontname="MI", fontsize=size)
            pg2.insert_text((cx + 20, y + 80), "合計　　　　　　人", fontname="MI", fontsize=size)
        y += h
    pg2.insert_text((X0, y + 30), "メールで送る時は、この表と同じことを本文に書いてもかまいません。", fontname="MI", fontsize=10)

    doc.set_metadata({"title": "防災訓練の参加予定人数のご報告について", "author": "危機管理課", "creator": "", "producer": "",
                      "creationDate": pdf_date(D(2026, 6, 26, 15, 10)), "modDate": pdf_date(D(2026, 7, 1, 9, 5))})
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)
    doc.close()


# ---------------------------------------------------------------------------
# 9. 班長名簿
# ---------------------------------------------------------------------------

def make_hancho(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "班長名簿"
    thin = Side(style="thin", color="666666")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    ws["A1"] = "2026年度　班長名簿（2026年4月 現在）"
    ws["A1"].font = Font(name="游ゴシック", size=14, bold=True)
    ws.merge_cells("A1:D1")
    head = ["班", "班長", "電話", "受け持つ世帯の数"]
    data = [("1班", "佐藤 健太", "090-0000-0011", 18), ("2班", "渡辺 由美", "090-0000-0012", 22),
            ("3班", "高橋 誠", "090-0000-0013", 20), ("4班", "加藤 裕子", "090-0000-0014", 16),
            ("5班", "中村 大輔", "090-0000-0015", 19)]
    for c, v in enumerate(head, start=1):
        cell = ws.cell(row=2, column=c, value=v)
        cell.font = Font(name="游ゴシック", size=11, bold=True)
        cell.fill = PatternFill("solid", fgColor="E2EFDA")
        cell.border = border
        cell.alignment = Alignment(horizontal="center")
    for r, row in enumerate(data, start=3):
        for c, v in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = Font(name="游ゴシック", size=11)
            cell.border = border
            cell.alignment = Alignment(horizontal="center" if c != 2 else "left")
    tr = 3 + len(data)
    ws.cell(row=tr, column=1, value="合計").font = Font(name="游ゴシック", size=11, bold=True)
    ws.cell(row=tr, column=4, value=sum(r[3] for r in data)).font = Font(name="游ゴシック", size=11, bold=True)
    for c in range(1, 5):
        ws.cell(row=tr, column=c).border = border
        ws.cell(row=tr, column=c).alignment = Alignment(horizontal="center")
    for col, w in zip("ABCD", [8, 16, 18, 18]):
        ws.column_dimensions[col].width = w
    created = D(2026, 4, 20, 20, 15)
    wb.properties.creator = "山田 一郎"
    wb.properties.lastModifiedBy = "山田 一郎"
    wb.properties.title = "班長名簿"
    wb.properties.created = utc_naive(created)
    wb.properties.modified = utc_naive(created + datetime.timedelta(minutes=20))
    wb.save(path)
    retime_zip(path, created + datetime.timedelta(minutes=20))


# ---------------------------------------------------------------------------
# 10. 会場の配置図（手描きを撮った形）
# ---------------------------------------------------------------------------

def make_haichi(out_path):
    W, H = 1654, 2339
    rng = random.Random(1010)
    img = new_paper(W, H, (250, 250, 247))
    d = ImageDraw.Draw(img)
    pen = (55, 55, 60)

    def hw(x, y, s, size=52, **kw):
        return handwrite(img, x, y, s, size, rng, path=F_GOTH_M, color=pen, jit_size=0.12, jit_rot=6, stroke=1, **kw)

    hw(170, 120, "収穫祭　会場の配置（10/19）", 66)
    hand_line(d, (160, 215), (1250, 210), rng, width=4, fill=pen)

    # 集会所
    hand_rect(d, (220, 330, 1180, 760), rng, width=6, fill=pen)
    hw(560, 470, "集会所", 72)
    # 入口（下の辺の切れ目と矢印）
    d.rectangle([600, 745, 760, 776], fill=(250, 250, 247))
    hand_line(d, (600, 742), (600, 790), rng, width=5, fill=pen)
    hand_line(d, (760, 742), (760, 790), rng, width=5, fill=pen)
    hw(585, 800, "集会所の入口", 42)
    hand_arrow(d, (680, 950), (680, 860), rng, width=4, fill=pen)
    # トイレ
    hand_rect(d, (1200, 420, 1450, 640), rng, width=5, fill=pen)
    hw(1245, 495, "トイレ", 52)

    # 広場
    hand_rect(d, (150, 980, 1500, 2050), rng, width=4, fill=pen, amp=2.2)
    hw(185, 1005, "広場", 50)

    # 豚汁のテント
    hand_rect(d, (220, 1120, 640, 1440), rng, width=5, fill=pen)
    hand_line(d, (220, 1120), (430, 1060), rng, width=4, fill=pen)
    hand_line(d, (430, 1060), (640, 1120), rng, width=4, fill=pen)
    hw(265, 1230, "豚汁の", 52)
    hw(265, 1305, "テント", 52)
    # 鍋の丸
    hand_ellipse(d, (500, 1330, 600, 1410), rng, width=4, fill=pen)

    # 野菜すくい
    hand_rect(d, (1000, 1120, 1420, 1420), rng, width=5, fill=pen)
    hw(1040, 1200, "野菜すくい", 50)
    for i in range(3):
        hand_ellipse(d, (1040 + i * 120, 1300, 1130 + i * 120, 1380), rng, width=3, fill=pen)

    # 抽選会の机
    hand_rect(d, (520, 1560, 1140, 1680), rng, width=5, fill=pen)
    hw(640, 1588, "抽選会の机", 52)

    # 受付と広場の入口
    hand_rect(d, (260, 1840, 600, 1960), rng, width=5, fill=pen)
    hw(350, 1868, "受付", 54)
    hw(700, 2080, "広場の入口（道路から）", 44)
    hand_arrow(d, (820, 2070), (820, 1960), rng, width=4, fill=pen)
    hand_arrow(d, (700, 1900), (610, 1900), rng, width=4, fill=pen)

    photo(img, out_path, seed=1011, desk="beige", fill=0.87, angle=-1.4, keystone=0.04, hand_shadow=True)


# ---------------------------------------------------------------------------
# 11. 年末の見回り（去年のお知らせと当番表。今年の日は役員が決めるので書かない）
# ---------------------------------------------------------------------------

def make_mimawari_oshirase(path, created, modified):
    body = []
    body.append(para("ささえ台自治会　会員の皆さまへ"))
    body.append(para("ささえ台自治会　会長　山田 一郎", align="right", after=360))
    body.append(para("年末の見回りのお知らせ", align="center", bold=True, size=16, after=360))
    body.append(para("年の瀬は、暖房や台所で火を使うことが増えます。", indent=0))
    body.append(para("例年どおり、班ごとに拍子木を鳴らしながら町内を回り、「火の用心」と声をかける年末の見回りを行います。"
                     "一晩だけでもかまいませんので、ご協力をお願いします。", after=240))
    body.append(para("記", align="center", after=200))
    rows = [
        ["日時", "2025年12月26日（金）から28日（日）まで\n毎晩　午後8時から8時40分ごろまで"],
        ["集合", "ささえ台集会所の前\n午後7時50分までにお集まりください"],
        ["回り方", "班ごとに分かれて、決まった道を回ります\n回る日と班は、当番表をご覧ください"],
        ["持ち物", "懐中電灯、温かい服装、手袋\n拍子木と腕章は集会所でお貸しします"],
        ["申し込み", "12月15日（月）までに、班長へお伝えください\n都合のよい日を選べます"],
        ["問い合わせ", "会長　山田 一郎　090-0000-0001"],
    ]
    body.append(table(rows, [1900, 7100]))
    body.append(para("", after=120))
    body.append(para("雨や雪の強い夜は取りやめます。取りやめる時は、班長からお知らせします。", size=10))
    body.append(para("回り終わったあと、集会所で温かい甘酒を用意しています。", size=10))
    body.append(para("以上", align="right", before=240))
    write_docx(path, "".join(body), title="年末の見回りのお知らせ", creator="山田 一郎",
               created=created, modified=modified, font_name="游明朝")


MIMAWARI = [
    ("12月26日（金）", "1班", "佐藤、田中", "1班と2班の通り"),
    ("12月26日（金）", "2班", "鈴木、渡辺、小林", "1班と2班の通り"),
    ("12月27日（土）", "3班", "高橋、伊藤", "3班と4班の通り"),
    ("12月27日（土）", "4班", "加藤、吉田", "3班と4班の通り"),
    ("12月28日（日）", "5班", "山本、中村", "5班の通りと集会所のまわり"),
]


def make_mimawari_touban(path, created, modified):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "見回りの当番"
    thin = Side(style="thin", color="666666")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    ws["A1"] = "2025年度　年末の見回り　当番表（12月26日〜28日）"
    ws["A1"].font = Font(name="游ゴシック", size=14, bold=True)
    ws.merge_cells("A1:E1")
    head = ["日", "班", "担当の世帯", "集合", "回る道"]
    for c, v in enumerate(head, start=1):
        cell = ws.cell(row=2, column=c, value=v)
        cell.font = Font(name="游ゴシック", size=11, bold=True)
        cell.fill = PatternFill("solid", fgColor="FCE4D6")
        cell.border = border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for r, (day, han, homes, route) in enumerate(MIMAWARI, start=3):
        for c, v in enumerate([day, han, homes, "午後7時50分　集会所の前", route], start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = Font(name="游ゴシック", size=11)
            cell.border = border
            cell.alignment = Alignment(vertical="center", horizontal="center" if c in (1, 2) else "left")
    last = 3 + len(MIMAWARI) + 1
    notes = ["拍子木と腕章は集会所の倉庫にあります。最後の日に数を確かめて戻してください。",
             "雨や雪の強い夜は取りやめます（班長から連絡）。"]
    for i, note in enumerate(notes):
        ws.cell(row=last + i, column=1, value=note).font = Font(name="游ゴシック", size=11)
        ws.merge_cells(start_row=last + i, start_column=1, end_row=last + i, end_column=5)
    for col, w in zip("ABCDE", [16, 8, 20, 22, 26]):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[1].height = 24
    ws.page_setup.orientation = "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    wb.properties.creator = "山田 一郎"
    wb.properties.lastModifiedBy = "山田 一郎"
    wb.properties.title = "年末の見回り 当番表"
    wb.properties.created = utc_naive(created)
    wb.properties.modified = utc_naive(modified)
    wb.save(path)
    retime_zip(path, modified)


def make_mimawari():
    """年末の見回りの去年の資料二つ。ほかの資料を作り直さずに、この二つだけ作れる。"""
    make_mimawari_oshirase(p("2025年度_年末の見回りのお知らせ.docx"),
                           created=D(2025, 12, 2, 20, 10), modified=D(2025, 12, 2, 21, 0))
    make_mimawari_touban(p("2025年度_年末の見回りの当番表.xlsx"),
                         created=D(2025, 12, 4, 19, 45), modified=D(2025, 12, 4, 20, 20))


def main():
    os.makedirs(OUT, exist_ok=True)
    # 組 1: 名前に (1) が付く方が古い版
    make_annai(p("2025年度_秋の収穫祭のご案内.docx"), "10月5日（日）", True,
               created=D(2025, 9, 20, 19, 40), modified=D(2025, 9, 20, 21, 5))
    make_annai(p("2025年度_秋の収穫祭のご案内(1).docx"), "10月3日（金）", False,
               created=D(2025, 9, 12, 20, 10), modified=D(2025, 9, 12, 21, 30))
    # 組 2: コピーの方が新しい版
    make_touban(p("2025年度_秋の収穫祭の当番表.xlsx"), False,
                created=D(2025, 10, 1, 19, 30), modified=D(2025, 10, 1, 20, 10))
    make_touban(p("2025年度_秋の収穫祭の当番表 - コピー.xlsx"), True,
                created=D(2025, 10, 10, 20, 0), modified=D(2025, 10, 10, 20, 25))
    pos = make_kaitou_pdf(p("2025年度_秋の収穫祭の回答票.pdf"))
    make_kaitou_photo(p("2025年度_秋の収穫祭の回答票.pdf"), pos, p("回答票_記入済み.jpg"))
    make_kiyaku(p("ささえ台自治会規約.pdf"))
    make_nenkan(p("2026年度_年間の予定.jpg"))
    # 組 3: _2 の方が新しい
    make_memo(p("2026年4月_役員会のメモ.jpg"), "18", "2026:04:12 21:08:33", photo_seed=7071, angle=-1.8, desk="darkwood")
    make_memo(p("2026年4月_役員会のメモ_2.jpg"), "25", "2026:04:19 20:47:05", photo_seed=7072, angle=2.3, desk="wood")
    make_shi(p("市からの依頼_防災訓練の参加者の報告.pdf"))
    make_hancho(p("2026年度_班長名簿.xlsx"))
    make_haichi(p("2025年度_収穫祭の会場の配置図.jpg"))
    make_mimawari()
    print("01 done")


if __name__ == "__main__":
    main()
