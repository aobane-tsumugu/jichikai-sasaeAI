# -*- coding: utf-8 -*-
"""02_関係ない資料 を作る。役員の手元や LINE に混じる、自治会の運営と関係ない物。

実行: python -X utf8 make_unrelated.py
"""
import datetime
import math
import os
import random

import fitz
import numpy as np
import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from PIL import Image, ImageDraw, ImageFilter

from common import (DIR_UNREL, F_GOTH_B, F_GOTH_M, F_MIN, F_UDG, crease, font, hand_line,
                    handwrite, new_paper, para, pdf_date, photo, retime_zip, table, text,
                    text_width, utc_naive, wrap_ja, write_docx, write_text)

D = datetime.datetime
OUT = DIR_UNREL


def p(name):
    return os.path.join(OUT, name)


def center(d, cx, y, s, size, path, fill, **kw):
    w = text_width(s, size, path)
    text(d, (cx - w / 2, y), s, size, path, fill=fill, **kw)


# ---------------------------------------------------------------------------
# 1. スーパーの特売チラシ
# ---------------------------------------------------------------------------

def make_chirashi(out_path):
    W, H = 1500, 2120
    img = new_paper(W, H, (255, 253, 245))
    d = ImageDraw.Draw(img)
    red = (205, 28, 38)
    yellow = (255, 222, 40)
    d.rectangle([0, 0, W, 300], fill=red)
    center(d, W / 2, 50, "さくらマート", 150, F_GOTH_B, (255, 255, 255))
    d.rectangle([0, 300, W, 420], fill=yellow)
    center(d, W / 2, 318, "週末の特売　3日間だけ", 76, F_GOTH_B, red)
    center(d, W / 2, 445, "11月7日（土）・8日（日）・9日（月）", 64, F_GOTH_B, (30, 30, 30))
    items = [
        ("キャベツ", "1玉", "128", (120, 180, 90)),
        ("たまご", "Mサイズ　10個入り", "198", (240, 220, 170)),
        ("鶏もも肉", "100gあたり", "88", (235, 160, 150)),
        ("さつまいも", "1本", "98", (170, 70, 120)),
        ("牛乳", "1000ml", "178", (235, 240, 250)),
        ("食パン", "6枚切り", "118", (225, 180, 110)),
        ("みかん", "1袋", "298", (250, 160, 30)),
        ("カップめん", "各種", "98", (230, 90, 60)),
    ]
    gx0, gy0 = 50, 560
    cw, ch = (W - 150) // 2, 300
    for i, (name, unit, price, col) in enumerate(items):
        cx = gx0 + (i % 2) * (cw + 50)
        cy = gy0 + (i // 2) * (ch + 30)
        d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=24, fill=(255, 255, 255), outline=red, width=6)
        d.ellipse([cx + 25, cy + 70, cx + 185, cy + 230], fill=col, outline=(90, 90, 90), width=3)
        text(d, (cx + 210, cy + 30), name, 54, F_GOTH_B, fill=(20, 20, 20))
        text(d, (cx + 212, cy + 100), unit, 34, F_GOTH_M, fill=(60, 60, 60))
        pw = text_width(price, 140, F_GOTH_B)
        text(d, (cx + cw - 110 - pw, cy + 120), price, 140, F_GOTH_B, fill=red)
        text(d, (cx + cw - 100, cy + 205), "円", 56, F_GOTH_B, fill=red)
    d.rectangle([0, H - 210, W, H], fill=red)
    center(d, W / 2, H - 185, "営業時間　9時から21時まで", 58, F_GOTH_B, (255, 255, 255))
    center(d, W / 2, H - 100, "表示の値段はすべて税込みです。数に限りがあります。", 40, F_GOTH_M, (255, 240, 200))
    img = crease(img, H // 2, strength=16)
    photo(img, out_path, seed=2011, desk="darkwood", fill=0.88, angle=2.6, keystone=0.03, curl=0.08)


# ---------------------------------------------------------------------------
# 2. 小学校の学年だより（PDF）
# ---------------------------------------------------------------------------

def make_gakunen(path):
    doc = fitz.open()
    pg = doc.new_page(width=595, height=842)
    pg.insert_font(fontname="GB", fontfile=F_GOTH_B)
    pg.insert_font(fontname="UD", fontfile=F_UDG)
    fm = fitz.Font(fontfile=F_UDG)
    fb = fitz.Font(fontfile=F_GOTH_B)
    X0, X1 = 56, 539
    pg.draw_rect(fitz.Rect(X0, 40, X1, 130), color=(0.25, 0.55, 0.35), fill=(0.88, 0.96, 0.89), width=1.5)
    t = "3年生　学年だより　11月号"
    pg.insert_text(((595 - fb.text_length(t, fontsize=24)) / 2, 88), t, fontname="GB", fontsize=24, color=(0.1, 0.35, 0.2))
    s = "ささえ台小学校　3年生　　2026年10月30日"
    pg.insert_text(((595 - fm.text_length(s, fontsize=11)) / 2, 115), s, fontname="UD", fontsize=11)
    y = 160
    size = 10.5
    lh = size * 1.8
    body = ("朝夕の冷えこみが感じられるようになりました。10月の運動会では、子どもたちが最後まで力いっぱい走る姿が見られました。"
            "たくさんのご声援をありがとうございました。11月は遠足や音楽会があります。体調に気をつけて過ごせるよう、ご家庭でもお声がけをお願いします。")
    for ln in wrap_ja("　" + body, fm, size, X1 - X0):
        pg.insert_text((X0, y), ln, fontname="UD", fontsize=size)
        y += lh
    y += 14
    pg.insert_text((X0, y), "11月の行事予定", fontname="GB", fontsize=13, color=(0.1, 0.35, 0.2))
    y += 10
    rows = [("3日", "火", "文化の日（お休み）"), ("5日", "木", "遠足（8時15分に運動場へ集合）"), ("13日", "金", "身体測定"),
            ("18日", "水", "授業参観・学級懇談会（5時間目）"), ("21日", "土", "音楽会（土曜参観）"),
            ("23日", "月", "勤労感謝の日（お休み）"), ("24日", "火", "音楽会の振替休日（お休み）"),
            ("27日", "金", "短縮授業（4時間目のあと下校）")]
    rh = 22
    cols = [X0, X0 + 60, X0 + 100, X1]
    pg.draw_rect(fitz.Rect(X0, y, X1, y + rh), color=(0, 0, 0), fill=(0.9, 0.9, 0.9), width=0.7)
    for i, h in enumerate(["日", "曜日", "行事"]):
        pg.insert_text((cols[i] + 8, y + 15), h, fontname="GB", fontsize=10.5)
    y += rh
    for r in rows:
        pg.draw_rect(fitz.Rect(X0, y, X1, y + rh), color=(0, 0, 0), width=0.7)
        for i, v in enumerate(r):
            pg.insert_text((cols[i] + 8, y + 15), v, fontname="UD", fontsize=10.5)
        y += rh
    for cx in cols[1:3]:
        pg.draw_line((cx, y - rh * (len(rows) + 1)), (cx, y), color=(0, 0, 0), width=0.7)
    y += 30
    pg.insert_text((X0, y), "持ち物", fontname="GB", fontsize=13, color=(0.1, 0.35, 0.2))
    y += 22
    mono = [
        ("遠足（5日）", "お弁当、水筒、しきもの、雨具、ハンカチ、ちり紙"),
        ("音楽会（21日）", "白いシャツ、黒か紺のズボンかスカート、リコーダー"),
        ("毎週", "体操服と上ばきは週末に持ち帰ります。洗って月曜日に持たせてください。"),
    ]
    for lab, val in mono:
        pg.insert_text((X0 + 6, y), "・" + lab, fontname="GB", fontsize=size)
        for ln in wrap_ja(val, fm, size, X1 - X0 - 120):
            pg.insert_text((X0 + 120, y), ln, fontname="UD", fontsize=size)
            y += lh
        y += 4
    y += 20
    pg.insert_text((X0, y), "おうちの方へのお願い", fontname="GB", fontsize=13, color=(0.1, 0.35, 0.2))
    y += 22
    for ln in wrap_ja("寒くなってきました。上着や手ぶくろなど、持ち物にはすべて名前を書いてください。"
                      "落とし物は、昇降口の箱に集めています。", fm, size, X1 - X0 - 12):
        pg.insert_text((X0 + 6, y), ln, fontname="UD", fontsize=size)
        y += lh
    pg.insert_text((X0, 800), "3年担任　1組 井上　2組 森", fontname="UD", fontsize=10)
    doc.set_metadata({"title": "3年生 学年だより 11月号", "author": "3年担任", "creator": "", "producer": "",
                      "creationDate": pdf_date(D(2026, 10, 28, 17, 40)), "modDate": pdf_date(D(2026, 10, 29, 16, 5))})
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)
    doc.close()


# ---------------------------------------------------------------------------
# 3. 買い物メモ
# ---------------------------------------------------------------------------

def make_kaimono(out_path):
    W, H = 1000, 1400
    rng = random.Random(3033)
    img = new_paper(W, H, (255, 249, 214))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 90], fill=(245, 200, 120))
    text(d, (40, 22), "MEMO", 44, F_GOTH_B, fill=(255, 255, 240))
    for k in range(10):
        y = 230 + k * 110
        d.line([(40, y), (W - 40, y)], fill=(225, 205, 160), width=2)
    pencil = (70, 70, 78)
    items = ["かいもの", "・牛乳", "・たまご", "・食パン", "・玉ねぎ　3こ", "・とうふ", "・洗たく洗剤", "・ティッシュ", "・電池（単3）"]
    for k, s in enumerate(items):
        y = 230 + k * 110 - 82
        handwrite(img, 70 + rng.uniform(-8, 8), y, s, 62 if k == 0 else 58, rng, path=F_GOTH_M, color=pencil,
                  jit_size=0.14, jit_rot=7, slope=rng.uniform(-0.006, 0.004), stroke=1, opacity=0.85)
    hand_line(d, (125, 520), (320, 508), rng, width=5, fill=pencil)  # 先に買えた物に線
    photo(img, out_path, seed=3034, desk="gray", fill=0.62, angle=-6.5, keystone=0.02, offset=(40, 60))


# ---------------------------------------------------------------------------
# 4. 家電の保証書
# ---------------------------------------------------------------------------

def make_hoshou(out_path):
    W, H = 1480, 2100
    rng = random.Random(4044)
    img = new_paper(W, H, (252, 252, 248))
    d = ImageDraw.Draw(img)
    green = (60, 130, 100)
    d.rectangle([40, 40, W - 40, H - 40], outline=green, width=10)
    d.rectangle([62, 62, W - 62, H - 62], outline=green, width=3)
    for x in range(90, W - 80, 36):
        d.ellipse([x, 72, x + 22, 94], outline=(150, 200, 175), width=2)
        d.ellipse([x, H - 94, x + 22, H - 72], outline=(150, 200, 175), width=2)
    center(d, W / 2, 140, "保　証　書", 110, F_MIN, (30, 30, 30))
    center(d, W / 2, 290, "ソラノ電機株式会社", 50, F_GOTH_B, green)
    rows = [("品名", "電子レンジ"), ("型番", "SR-MW26"), ("製造番号", "2510-04417"),
            ("保証期間", "お買い上げ日から1年間（本体）"), ("お買い上げ日", ""), ("お客様のお名前", ""),
            ("ご住所", ""), ("販売店", "")]
    x0, x1, x2 = 130, 520, W - 130
    y = 400
    rh = 118
    cells = {}
    for lab, val in rows:
        h = rh * (1.6 if lab == "販売店" else 1)
        d.rectangle([x0, y, x1, y + h], fill=(232, 243, 236), outline=(40, 40, 40), width=3)
        d.rectangle([x1, y, x2, y + h], outline=(40, 40, 40), width=3)
        text(d, (x0 + 30, y + h / 2), lab, 44, F_GOTH_M, anchor="lm")
        if val:
            text(d, (x1 + 30, y + h / 2), val, 46, F_GOTH_M, anchor="lm")
        cells[lab] = (x1, y, h)
        y += h
    ink = (30, 30, 70)
    cx, cy, ch = cells["お買い上げ日"]
    handwrite(img, cx + 40, cy + 30, "2025年12月14日", 54, rng, color=ink, jit_rot=5, stroke=1)
    cx, cy, ch = cells["お客様のお名前"]
    handwrite(img, cx + 40, cy + 28, "伊藤　さゆり", 58, rng, color=ink, jit_rot=6, stroke=1)
    text(d, (x2 - 90, cy + ch / 2), "様", 44, F_GOTH_M, anchor="lm")
    # 販売店の判（赤い枠の印）
    cx, cy, ch = cells["販売店"]
    stamp = Image.new("L", (560, 170), 0)
    sd = ImageDraw.Draw(stamp)
    sd.rectangle([4, 4, 556, 166], outline=255, width=7)
    sd.text((280, 60), "ささえ台でんき", font=font(F_GOTH_B, 60), fill=255, anchor="mm")
    sd.text((280, 126), "電話　090-0000-0301", font=font(F_GOTH_M, 36), fill=255, anchor="mm")
    stamp = stamp.rotate(-3, resample=Image.BICUBIC, expand=True).point(lambda v: int(v * 0.8))
    img.paste(Image.new("RGB", stamp.size, (200, 40, 50)), (cx + 60, int(cy + 10)), stamp)
    y += 60
    notes = ["この保証書は、本書に書かれた内容で無料修理を行うことをお約束するものです。",
             "保証期間中に故障した時は、本書をお持ちのうえ、お買い上げの販売店にご依頼ください。",
             "お客様にご記入いただいたことは、修理のご連絡のためだけに使います。",
             "この保証書は再発行しません。大切に保管してください。"]
    for n in notes:
        text(d, (x0, y), "・" + n, 30, F_GOTH_M, fill=(50, 50, 50))
        y += 52
    center(d, W / 2, H - 170, "ソラノ電機株式会社　お客様ご相談窓口　090-0000-0300", 34, F_GOTH_M, (40, 40, 40))
    photo(img, out_path, seed=4045, desk="wood", fill=0.86, angle=1.9, keystone=0.035)


# ---------------------------------------------------------------------------
# 5. 歯医者の予約票
# ---------------------------------------------------------------------------

def make_yoyaku(out_path):
    W, H = 1200, 720
    rng = random.Random(5055)
    img = new_paper(W, H, (253, 251, 243))
    d = ImageDraw.Draw(img)
    teal = (40, 140, 140)
    d.rectangle([0, 0, W, 120], fill=teal)
    text(d, (50, 60), "ささえ台歯科医院", 60, F_GOTH_B, fill=(255, 255, 255), anchor="lm")
    text(d, (W - 50, 60), "予約票", 50, F_GOTH_B, fill=(255, 255, 255), anchor="rm")
    d.line([(60, 235), (760, 235)], fill=(60, 60, 60), width=3)
    text(d, (775, 235), "様", 46, F_GOTH_M, anchor="ls")
    ink = (25, 30, 70)
    handwrite(img, 110, 160, "伊藤　さゆり", 58, rng, color=ink, jit_rot=6, stroke=1)
    tx0, tx1, tx2, tx3 = 60, 470, 640, W - 60
    ty = 270
    d.rectangle([tx0, ty, tx3, ty + 60], fill=(225, 240, 240), outline=(60, 60, 60), width=3)
    for (a, b), lab in zip([(tx0, tx1), (tx1, tx2), (tx2, tx3)], ["月日", "曜日", "時間"]):
        text(d, ((a + b) / 2, ty + 30), lab, 38, F_GOTH_M, anchor="mm")
    for r in range(2):
        y = ty + 60 + r * 90
        for a, b in [(tx0, tx1), (tx1, tx2), (tx2, tx3)]:
            d.rectangle([a, y, b, y + 90], outline=(60, 60, 60), width=3)
    handwrite(img, tx0 + 70, ty + 78, "11月12日", 56, rng, color=ink, jit_rot=5, stroke=1)
    handwrite(img, tx1 + 60, ty + 78, "木", 56, rng, color=ink, stroke=1)
    handwrite(img, tx2 + 120, ty + 78, "15:30", 56, rng, color=ink, stroke=1)
    text(d, (60, 540), "診療時間　9:00〜12:30　14:30〜19:00", 34, F_GOTH_M, fill=(40, 40, 40))
    text(d, (60, 590), "休診日　水曜の午後、日曜、祝日", 34, F_GOTH_M, fill=(40, 40, 40))
    text(d, (60, 640), "予約の変更は前日までにお電話ください　090-0000-0201", 32, F_GOTH_M, fill=(40, 40, 40))
    photo(img, out_path, seed=5056, desk="green", fill=0.66, angle=-4.0, keystone=0.03, offset=(-20, -80))


# ---------------------------------------------------------------------------
# 6. 町外の夏祭りのチラシ
# ---------------------------------------------------------------------------

def make_natsu(out_path):
    W, H = 1500, 2120
    rng = random.Random(6066)
    yy = [i / H for i in range(H)]
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for i, t in enumerate(yy):
        c = (int(14 + 60 * t), int(22 + 10 * t), int(70 + 30 * t))
        d.line([(0, i), (W, i)], fill=c)
    # 花火
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for (fx, fy, r, col) in [(330, 1010, 230, (255, 120, 160)), (1150, 960, 260, (255, 220, 90)),
                             (740, 1110, 150, (120, 220, 255))]:
        for k in range(48):
            a = 2 * math.pi * k / 48 + rng.uniform(-0.03, 0.03)
            rr = r * rng.uniform(0.75, 1.0)
            for j in range(6):
                t0 = 0.25 + j * 0.13
                x = fx + math.cos(a) * rr * t0
                y = fy + math.sin(a) * rr * t0 + (t0 ** 2) * 18
                s = 6 - j * 0.6
                gd.ellipse([x - s, y - s, x + s, y + s], fill=col)
    glow_b = glow.filter(ImageFilter.GaussianBlur(10))
    img = Image.fromarray(np.clip(np.asarray(img, np.int32) + np.asarray(glow_b, np.int32) // 2
                                  + np.asarray(glow, np.int32), 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    # ちょうちん
    d.line([(0, 70), (W, 110)], fill=(30, 30, 30), width=4)
    for k in range(8):
        cx = 90 + k * 190
        cy = 150 + k * 5
        d.ellipse([cx - 60, cy - 75, cx + 60, cy + 75], fill=(220, 40, 40), outline=(60, 10, 10), width=3)
        d.rectangle([cx - 40, cy - 85, cx + 40, cy - 70], fill=(30, 30, 30))
        d.rectangle([cx - 40, cy + 70, cx + 40, cy + 85], fill=(30, 30, 30))
        text(d, (cx, cy), "祭", 64, F_GOTH_B, fill=(255, 245, 220), anchor="mm")
    center(d, W / 2, 290, "第12回", 64, F_GOTH_B, (255, 255, 255))
    center(d, W / 2, 380, "そよかぜ町", 120, F_GOTH_B, (255, 255, 255))
    t = "夏まつり"
    tw = text_width(t, 260, F_GOTH_B)
    d.text(((W - tw) / 2, 500), t, font=font(F_GOTH_B, 260), fill=(255, 225, 40), stroke_width=12, stroke_fill=(200, 30, 40))
    # 日時と会場
    d.rounded_rectangle([110, 1300, W - 110, 1640], radius=40, fill=(255, 255, 255))
    center(d, W / 2, 1325, "2026年", 54, F_GOTH_B, (200, 30, 40))
    center(d, W / 2, 1385, "8月1日（土）", 130, F_GOTH_B, (200, 30, 40))
    center(d, W / 2, 1545, "16時から21時まで　　会場　そよかぜ町　中央公園", 52, F_GOTH_B, (30, 30, 60))
    # 内容
    tags = [("盆おどり", (240, 120, 40)), ("屋台", (60, 160, 90)), ("子どもみこし", (60, 120, 210)),
            ("ビンゴ大会", (180, 60, 160))]
    x = 110
    for s, col in tags:
        w = text_width(s, 50, F_GOTH_B) + 70
        d.rounded_rectangle([x, 1690, x + w, 1790], radius=50, fill=col)
        text(d, (x + w / 2, 1740), s, 50, F_GOTH_B, fill=(255, 255, 255), anchor="mm")
        x += w + 26
    center(d, W / 2, 1830, "花火　20時30分から", 80, F_GOTH_B, (255, 230, 60))
    center(d, W / 2, 1960, "雨の時は8月2日（日）に延ばします", 44, F_GOTH_M, (255, 255, 255))
    center(d, W / 2, 2030, "主催　そよかぜ町夏まつり実行委員会　問い合わせ　090-0000-0401", 36, F_GOTH_M, (220, 220, 240))
    img = crease(img, H // 2, horizontal=True, strength=18)
    photo(img, out_path, seed=6067, desk="wood", fill=0.88, angle=-2.0, keystone=0.04, hand_shadow=True)


# ---------------------------------------------------------------------------
# 7. 年賀状
# ---------------------------------------------------------------------------

def make_nenga(out_path):
    W, H = 1000, 1480
    rng = random.Random(7077)
    img = new_paper(W, H, (253, 250, 242))
    d = ImageDraw.Draw(img)
    red = (196, 30, 40)
    d.ellipse([560, 170, 900, 510], fill=(230, 70, 60))
    d.ellipse([540, 150, 920, 530], outline=(210, 170, 60), width=8)
    # 山
    d.polygon([(60, 760), (330, 470), (520, 690), (690, 560), (940, 760)], fill=(70, 100, 140))
    d.polygon([(260, 545), (330, 470), (400, 550), (360, 530), (330, 560), (300, 530)], fill=(250, 250, 250))
    # 梅の花
    for (fx, fy) in [(150, 230), (250, 330), (120, 400)]:
        for k in range(5):
            a = 2 * math.pi * k / 5
            x, y = fx + math.cos(a) * 28, fy + math.sin(a) * 28
            d.ellipse([x - 22, y - 22, x + 22, y + 22], fill=(235, 120, 150))
        d.ellipse([fx - 12, fy - 12, fx + 12, fy + 12], fill=(250, 220, 90))
    center(d, W / 2, 820, "謹賀新年", 150, F_MIN, red)
    center(d, W / 2, 1020, "旧年中は大変お世話になりました", 40, F_MIN, (40, 40, 40))
    center(d, W / 2, 1075, "本年もどうぞよろしくお願いいたします", 40, F_MIN, (40, 40, 40))
    center(d, W / 2, 1140, "2026年　元旦", 36, F_MIN, (40, 40, 40))
    handwrite(img, 110, 1220, "お元気ですか。春になったら", 44, rng, color=(20, 20, 30), jit_rot=6, stroke=1)
    handwrite(img, 110, 1285, "またお茶しましょう。", 44, rng, color=(20, 20, 30), jit_rot=6, stroke=1)
    text(d, (W - 90, 1400), "佐々木 誠・恵子", 38, F_MIN, fill=(40, 40, 40), anchor="rs")
    photo(img, out_path, seed=7078, desk="darkwood", fill=0.70, angle=3.2, keystone=0.03, offset=(10, -20))


# ---------------------------------------------------------------------------
# 8. 料理のレシピ（docx）
# ---------------------------------------------------------------------------

def make_recipe(path):
    body = []
    body.append(para("かぼちゃの煮物", bold=True, size=16, after=240))
    body.append(para("材料（4人分）", bold=True, after=80))
    body.append(table([["かぼちゃ", "4分の1個（約400g）"], ["水", "200ml"], ["砂糖", "大さじ2"],
                       ["しょうゆ", "大さじ1と2分の1"], ["みりん", "大さじ1"]], [3000, 4500], bold_first_col=False))
    body.append(para("", after=120))
    body.append(para("作り方", bold=True, after=80))
    steps = ["かぼちゃは種とわたを取り、3cmくらいの大きさに切る。皮はところどころむく。",
             "鍋に、皮を下にしてかぼちゃを並べ、水と砂糖を入れて火にかける。",
             "煮立ったら弱火にし、ふたをして5分煮る。",
             "しょうゆとみりんを入れ、さらに10分ほど、竹串がすっと通るまで煮る。",
             "火を止めて、そのまま冷まして味をしみこませる。"]
    for i, s in enumerate(steps, start=1):
        body.append(para("{}．{}".format(i, s), indent=420, hanging=420))
    body.append(para("", after=120))
    body.append(para("ひとこと", bold=True, after=80))
    body.append(para("煮くずれしやすいので、煮ている間はかき混ぜないこと。次の日の方が味がなじんでおいしい。"))
    write_docx(path, "".join(body), title="かぼちゃの煮物", creator="伊藤 さゆり",
               created=D(2025, 11, 2, 15, 20), modified=D(2025, 11, 2, 15, 45), font_name="游ゴシック")


# ---------------------------------------------------------------------------
# 9. 家計簿（xlsx）
# ---------------------------------------------------------------------------

def make_kakeibo(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "10月"
    thin = Side(style="thin", color="888888")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    fb = Font(name="游ゴシック", size=11, bold=True)
    fn = Font(name="游ゴシック", size=11)
    ws["A1"] = "家計簿　2026年10月"
    ws["A1"].font = Font(name="游ゴシック", size=14, bold=True)
    head = ["日付", "費目", "内容", "支出", "収入"]
    for c, v in enumerate(head, start=1):
        cell = ws.cell(row=3, column=c, value=v)
        cell.font = fb
        cell.fill = PatternFill("solid", fgColor="FCE4D6")
        cell.border = border
        cell.alignment = Alignment(horizontal="center")
    data = [
        (1, "食費", "さくらマート", 3280, None),
        (3, "日用品", "ドラッグストア（洗剤、ティッシュ）", 1460, None),
        (5, "食費", "さくらマート", 4120, None),
        (7, "光熱費", "電気代", 8650, None),
        (8, "通信費", "スマホ", 4980, None),
        (10, "食費", "パン屋", 860, None),
        (12, "医療", "歯医者", 1520, None),
        (13, "食費", "さくらマート", 5340, None),
        (15, "光熱費", "ガス代", 4210, None),
        (17, "交際費", "お祝い", 5000, None),
        (18, "食費", "外食（そば）", 2400, None),
        (20, "光熱費", "水道代", 3890, None),
        (21, "日用品", "電池、ごみ袋", 980, None),
        (24, "食費", "さくらマート", 4760, None),
        (25, "収入", "給料", None, 238000),
        (26, "交通費", "ガソリン", 5200, None),
        (28, "食費", "さくらマート", 3950, None),
        (31, "教育", "習いごと", 5500, None),
    ]
    r = 4
    for day, cat, memo, out, inc in data:
        vals = [datetime.date(2026, 10, day), cat, memo, out, inc]
        for c, v in enumerate(vals, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = fn
            cell.border = border
            if c == 1:
                cell.number_format = "m月d日"
            if c in (4, 5):
                cell.number_format = "#,##0"
        r += 1
    total_out = sum(x[3] or 0 for x in data)
    total_in = sum(x[4] or 0 for x in data)
    for lab, v_out, v_in in [("合計", total_out, total_in)]:
        ws.cell(row=r, column=3, value=lab).font = fb
        ws.cell(row=r, column=4, value=v_out).font = fb
        ws.cell(row=r, column=5, value=v_in).font = fb
        for c in (3, 4, 5):
            ws.cell(row=r, column=c).border = border
            if c > 3:
                ws.cell(row=r, column=c).number_format = "#,##0"
    r += 1
    ws.cell(row=r, column=3, value="残り").font = fb
    ws.cell(row=r, column=5, value=total_in - total_out).font = fb
    ws.cell(row=r, column=5).number_format = "#,##0"
    # 費目ごと
    ws["G3"] = "費目"
    ws["H3"] = "支出"
    for c in ("G3", "H3"):
        ws[c].font = fb
        ws[c].fill = PatternFill("solid", fgColor="FCE4D6")
        ws[c].border = border
    cats = {}
    for _, cat, _, out, _ in data:
        if out:
            cats[cat] = cats.get(cat, 0) + out
    rr = 4
    for cat, v in sorted(cats.items(), key=lambda kv: -kv[1]):
        ws.cell(row=rr, column=7, value=cat).font = fn
        ws.cell(row=rr, column=8, value=v).font = fn
        ws.cell(row=rr, column=8).number_format = "#,##0"
        ws.cell(row=rr, column=7).border = border
        ws.cell(row=rr, column=8).border = border
        rr += 1
    for col, w in zip("ABCDEFGH", [10, 10, 34, 12, 12, 3, 10, 12]):
        ws.column_dimensions[col].width = w
    modified = D(2026, 10, 31, 22, 10)
    wb.properties.creator = "伊藤 さゆり"
    wb.properties.lastModifiedBy = "伊藤 さゆり"
    wb.properties.title = "家計簿"
    wb.properties.created = utc_naive(D(2026, 10, 1, 21, 0))
    wb.properties.modified = utc_naive(modified)
    wb.save(path)
    retime_zip(path, modified)


# ---------------------------------------------------------------------------
# 10. LINE の雑談
# ---------------------------------------------------------------------------

ZATSUDAN = [
    "おはようございます。今日もよろしくお願いします。",
    "今朝はずいぶん冷えましたね。",
    "昨日はありがとうございました。助かりました。",
    "雨が降ってきたので、洗濯物に気をつけてください。",
    "お疲れさまです。",
    "了解しました。",
    "来週は少し暖かくなるみたいですね。",
    "写真ありがとうございます。",
    "遅くなってすみません。今帰りました。",
    "おやすみなさい。",
]


def main():
    os.makedirs(OUT, exist_ok=True)
    make_chirashi(p("スーパーの特売チラシ.jpg"))
    make_gakunen(p("小学校の学年だより.pdf"))
    make_kaimono(p("買い物メモ.jpg"))
    make_hoshou(p("家電の保証書.jpg"))
    make_yoyaku(p("歯医者の予約票.jpg"))
    make_natsu(p("町外の夏祭りのチラシ.jpg"))
    make_nenga(p("年賀状.jpg"))
    make_recipe(p("料理のレシピ.docx"))
    make_kakeibo(p("家計簿.xlsx"))
    write_text(p("LINEの雑談.txt"), "\n".join(ZATSUDAN) + "\n")
    print("02 done")


if __name__ == "__main__":
    main()
