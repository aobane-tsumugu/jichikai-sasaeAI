"""fixtures/ の架空データを作り直す。

全て新しく作った架空の内容で、実在の団体、人物、資料を元にしていない。人の名前には
「架空 」を付け、連絡先は 000-0000-xxxx、メールは example.invalid にしてある。

    python fixtures/build/build_fixtures.py

必要な物は fixtures/build/requirements.txt と、Windows の標準字体（paper.py 参照）。
同じ入力から同じ中身ができるように、乱数の種と日時を固定している。
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import paper as P  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]  # fixtures/
K = "架空 "  # 人と事業所の名前の頭に付ける印
WARD = "架空の区"
CITY = "架空市"

LAST = dt.date(2025, 10, 25)
THIS = dt.date(2026, 10, 24)
RAIN_DAY = dt.date(2026, 10, 23)
assert LAST.weekday() == THIS.weekday() == 5, "祭りの日は土曜"
assert RAIN_DAY.weekday() == 4

SLOTS = [
    ("設営", "9:00-10:30"),
    ("受付", "10:30-12:00"),
    ("模擬店", "12:00-14:00"),
    ("片付け", "14:00-15:00"),
]
JST = dt.timezone(dt.timedelta(hours=9))


def out(rel: str) -> Path:
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def write_text(rel: str, text: str) -> None:
    out(rel).write_text(text.rstrip("\n") + "\n", encoding="utf-8", newline="\n")


def write_json(rel: str, value) -> None:
    write_text(rel, json.dumps(value, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- 名簿

GROUPS = {
    "1班": ["小林", "佐藤", "鈴木", "高橋", "渡辺", "伊藤", "山本", "中村", "加藤", "吉田",
           "山田", "佐々木", "山口", "松本", "斎藤", "清水", "森", "井上"],
    "2班": ["木村", "池田", "橋本", "石川", "阿部", "石井", "小川", "前田", "岡田", "長谷川",
           "村上", "近藤", "石田", "坂本", "遠藤", "青木"],
    "3班": ["田中", "田中", "藤井", "西村", "福田", "太田", "三浦", "藤原", "岡本", "松田",
           "中川", "中野", "原田", "小野", "田村", "竹内", "金子", "和田", "上田", "中山"],
}
GIVEN = ["あき", "しの", "はる", "なつ", "ふゆ", "あおい", "かえで", "ひかる", "ゆう", "まこと",
         "ちひろ", "いおり", "さち", "あゆむ", "かな", "りん", "そら", "なお", "ゆず", "れん"]
# 回答や手伝いに出てくる人は、名簿の代表者の名前と合わせる
GIVEN_FIXED = {("1班", 0): "さと", ("2班", 0): "あき", ("2班", 1): "みのり",
               ("3班", 0): "ひろ", ("3班", 1): "けい", ("3班", 3): "しの",
               ("2班", 2): "はる", ("3班", 10): "ゆう"}


def build_roster() -> list[dict]:
    rows = []
    n = 0
    for group, surnames in GROUPS.items():
        for i, s in enumerate(surnames):
            n += 1
            given = GIVEN_FIXED.get((group, i)) or GIVEN[(n * 7) % len(GIVEN)]
            rows.append({"番号": n, "班": group, "世帯名": f"{K}{s}", "氏名": f"{K}{s}{given}"})
    return rows


ROSTER = build_roster()
assert len(ROSTER) == 54
assert [len(v) for v in GROUPS.values()] == [18, 16, 20]


def household(group: str, surname: str, nth: int = 0) -> dict:
    hits = [r for r in ROSTER if r["班"] == group and r["世帯名"] == K + surname]
    return hits[nth]


def write_roster() -> None:
    # Excel で開く CSV は BOM 付き
    with out("roster/加入世帯_2026秋.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["番号", "班", "世帯名", "氏名"], lineterminator="\n")
        w.writeheader()
        w.writerows(ROSTER)


# ---------------------------------------------------------------- 去年: 書記の束 (Word)

def make_docx(rel: str, title: str, blocks: list[tuple]) -> None:
    from docx import Document
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor

    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(2.0)
    sec.left_margin = sec.right_margin = Cm(2.2)
    for name in ("Normal", "Title", "Heading 2"):
        st = doc.styles[name]
        st.font.name = "MS Gothic"
        st.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "MS Gothic")
        st.font.color.rgb = RGBColor(0, 0, 0)
    doc.styles["Normal"].font.size = Pt(11)
    doc.styles["Title"].font.size = Pt(18)
    doc.styles["Heading 2"].font.size = Pt(12)
    doc.add_paragraph(title, "Title")
    for kind, *rest in blocks:
        if kind == "p":
            p = doc.add_paragraph(rest[0])
            p.paragraph_format.space_after = Pt(6)
        elif kind == "h":
            doc.add_paragraph(rest[0], "Heading 2")
        elif kind == "small":
            p = doc.add_paragraph()
            run = p.add_run(rest[0])
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
        elif kind == "table":
            rows = rest[0]
            t = doc.add_table(rows=len(rows), cols=len(rows[0]))
            t.style = "Table Grid"
            for r, row in enumerate(rows):
                for c, cell in enumerate(row):
                    t.cell(r, c).text = cell
            doc.add_paragraph("")
    cp = doc.core_properties
    cp.author = "架空資料の作成用"
    cp.title = title
    cp.created = cp.modified = dt.datetime(2026, 11, 5, 0, 0, 0)
    cp.last_modified_by = "架空資料の作成用"
    cp.comments = "全て架空の資料"
    doc.save(out(rel))


def write_secretary() -> None:
    make_docx("last-year/secretary/お知らせ_最終2.docx", "秋の収穫祭のお知らせ（下書き）", [
        ("small", "全て架空の資料です。実在の団体や人物の資料ではありません。"),
        ("p", "作成 2025年9月12日（書記の手元に残った下書き。ファイル名は「最終2」）"),
        ("h", "日時"),
        ("p", "2025年10月25日（土）11時から14時"),
        ("h", "場所"),
        ("p", "公民館前の広場。雨天の時は公民館のホールと集会室で行います。"),
        ("h", "催し"),
        ("p", "豚汁、焼き芋、新米のおにぎり、子ども向けの輪投げ、収穫物の品評、抽選"),
        ("h", "手伝いの募集"),
        ("table", [["時間帯", "仕事"], ["9:00-10:30", "設営"], ["10:30-14:00", "受付と模擬店"],
                   ["14:00-15:00", "片付け"]]),
        ("p", "自治会に加入していない世帯の方も、来場や一回の手伝いで参加できます。"),
        ("h", "回答"),
        ("p", "同封の回答票を班長にお渡しください。10月10日（金）までにお願いします。"),
        ("p", "公開用の連絡先 festival@example.invalid"),
        ("small", "（下書きの末尾に残ったメモ。配る前に消す）"),
        ("small", f"協賛 {K}商店A 5000円、{K}農園B 3000円。依頼は{K}井上（000-0000-0103）。公開案からは外す。"),
    ])
    make_docx("last-year/secretary/実施報告_去年.docx", "2025年 秋の収穫祭 実施報告", [
        ("small", "全て架空の資料です。実在の団体や人物の資料ではありません。"),
        ("p", "作成 2025年11月2日（書記）"),
        ("h", "実施"),
        ("p", "2025年10月25日（土）11時から14時。晴れ。公民館前の広場で実施しました。"),
        ("h", "参加"),
        ("p", "来場 118人。手伝い 16人（未加入の世帯の人 2人を含む。加入の受付とは別に数えました）。"),
        ("h", "役割"),
        ("p", "役員は案内、連絡、買い出し、現金の管理。手伝いは設営、受付、模擬店、片付け。"
              "紙の配達、買い出し、当日の運営は人が行いました。"),
        ("h", "支出"),
        ("p", "26,000円（食材、紙コップなど）"),
        ("h", "反省"),
        ("p", "受付の場所が分かりにくかった。入口にのぼりを立てる。"),
        ("p", "雨天の机と椅子の位置は、当日の図に残っていない。来年は雨天の配置も図にしておく。"),
        ("p", "焼き芋は火を使うので、置き場所を事前に公民館と相談しておく。"),
        ("small", "（役員用の会計メモ。公開の報告に使う前に確認）"),
        ("small", "支出26000円（領収12000円＋14000円分）、協賛8000円。領収の原本は会計の束。"),
    ])


# ---------------------------------------------------------------- 去年: 副会長の束 (Excel と PDF)

COMMITTEE_2025 = [
    ("1班", "井上", "実行委員長", "000-0000-0103", "副会長。連絡は役員間。"),
    ("1班", "加藤", "設営・片付け", "000-0000-0104", "役員ではない住民。"),
    ("1班", "小林", "受付", "000-0000-0106", "班長とは別の立場。"),
    ("1班", "佐々木", "受付", "000-0000-0107", ""),
    ("1班", "高橋", "模擬店", None, "電話の欄は未記入。"),
    ("1班", "渡辺", "模擬店", "000-0000-0108", ""),
    ("3班", "田中", "片付け", "000-0000-0109", "下の名前は書いていない。"),
]


def write_committee_xlsx() -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "2025 実行委員"
    ws["A2"] = "2025年 秋の収穫祭 実行委員名簿"
    ws["A2"].font = Font(name="MS Gothic", size=15, bold=True)
    ws["A3"] = "架空資料  副会長保管  2025年10月18日"
    ws["A4"] = "去年の名簿です。今年の就任と手伝いを確認した名簿ではありません。"
    head = ["班", "氏名", "役", "電話（架空）", "手元のメモ"]
    for c, v in enumerate(head, 1):
        cell = ws.cell(row=5, column=c, value=v)
        cell.font = Font(name="MS Gothic", bold=True)
        cell.fill = PatternFill("solid", fgColor="E5E5E5")
        cell.alignment = Alignment(horizontal="center")
    for r, (g, name, role, tel, memo) in enumerate(COMMITTEE_2025, 6):
        for c, v in enumerate([g, K + name, role, tel, memo], 1):
            ws.cell(row=r, column=c, value=v).font = Font(name="MS Gothic")
    last = 5 + len(COMMITTEE_2025)
    ws.cell(row=last + 3, column=1, value="名簿の人数").font = Font(name="MS Gothic")
    ws.cell(row=last + 3, column=2, value=len(COMMITTEE_2025)).font = Font(name="MS Gothic")
    for col, width in zip("ABCDE", (8, 20, 16, 22, 36)):
        ws.column_dimensions[col].width = width
    wb.properties.creator = "架空資料の作成用"
    wb.properties.created = wb.properties.modified = dt.datetime(2026, 11, 5, 0, 0, 0)
    wb.save(out("last-year/vice-chair/実行委員_去年.xlsx"))


def write_rota_pdf() -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("BIZ", str(P.FONT_DIR / P.PRINT), subfontIndex=0))
    c = canvas.Canvas(str(out("last-year/vice-chair/当日配布.pdf")), pagesize=A4, invariant=1,
                      pageCompression=1)
    c.setTitle("2025年 秋の収穫祭 当番表")
    c.setAuthor("架空資料の作成用")
    w, h = A4
    c.setFont("BIZ", 9)
    c.drawString(48, h - 40, "全て架空の資料です。実在の団体や人物の資料ではありません。")
    c.setFont("BIZ", 18)
    c.drawString(48, h - 80, "2025年 秋の収穫祭 当番表")
    c.setFont("BIZ", 11)
    c.drawString(48, h - 104, "2025年10月18日  実行委員と班長に配った紙（副会長の手元に残った分）")
    rows = [("時間", "仕事", "担当"),
            ("9:00-10:30", "テント設営", f"{K}井上、{K}加藤"),
            ("10:30-12:00", "受付", f"{K}小林、{K}佐々木"),
            ("12:00-14:00", "模擬店", f"{K}高橋、{K}渡辺"),
            ("14:00-15:00", "片付け", f"{K}加藤、{K}田中")]
    xs = [48, 170, 290, 548]
    y = h - 150
    for i, row in enumerate(rows):
        c.setFont("BIZ", 12)
        for x, cell in zip(xs, row):
            c.drawString(x + 6, y - 20, cell)
        c.line(xs[0], y, xs[-1], y)
        y -= 34
    c.line(xs[0], y, xs[-1], y)
    for x in xs:
        c.line(x, h - 150, x, y)
    c.setFont("BIZ", 11)
    c.drawString(48, y - 36, f"問い合わせ  実行委員長 {K}井上  000-0000-0103")
    c.drawString(48, y - 56, "集合 9時に公民館前の広場。雨の時は玄関の前。")
    c.showPage()
    c.save()


# ---------------------------------------------------------------- 写真風の画像

def scene_single(sheet: P.Sheet, seed: int, kind="wood", canvas=(1500, 2000), crease=0,
                 angle=None, fill=0.92) -> P.Image.Image:
    rng = random.Random(seed)
    cv = P.desk(canvas[0], canvas[1], seed, kind)
    sc = min(canvas[0] * fill / sheet.w, canvas[1] * fill / sheet.h)
    ang = rng.uniform(-2.2, 2.2) if angle is None else angle
    P.place(cv, sheet, (canvas[0] / 2 + rng.uniform(-14, 14), canvas[1] / 2 + rng.uniform(-14, 14)),
            sc, ang, seed=seed, crease=crease)
    return P.finish(cv, seed)


def scene_multi(sheets: list[P.Sheet], seed: int, kind="wood", width=1500) -> P.Image.Image:
    """複数の紙を縦に並べて一枚に写す。紙どうしは重ならない。"""
    rng = random.Random(seed)
    n = len(sheets)
    band = 780
    canvas = (width, band * n + 60)
    cv = P.desk(canvas[0], canvas[1], seed, kind)
    for i, sh in enumerate(sheets):
        sc = min(canvas[0] * 0.86 / sh.w, band * 0.86 / sh.h)
        cx = canvas[0] / 2 + rng.uniform(-30, 30)
        cy = 30 + band * (i + 0.5) + rng.uniform(-8, 8)
        P.place(cv, sh, (cx, cy), sc, rng.uniform(-2.8, 2.8), seed=seed + i * 17 + 1, jitter=8)
    return P.finish(cv, seed, out_long=max(canvas))


def save_photo(im, rel: str) -> None:
    P.save_jpeg(im, out(rel))


# ---- 回答票 ----

HELP_OPTIONS = [f"{n} {t}" for n, t in SLOTS]


def answer_slip(seed: int, group: str, hh: str, adults: int, children: int,
                help_name: str | None, slot: int | None, note: str, ink) -> P.Sheet:
    rng = random.Random(seed)
    s = P.Sheet(1000, 700, rng)
    s.rect((12, 12, 988, 688), width=3)
    s.print((44, 32), "秋の収穫祭 回答票", 44, bold=True)
    s.rect((826, 28, 956, 100), width=3)
    s.print((848, 36), group, 48, bold=True)
    s.print((46, 94), "2026年10月24日（土）11時から14時  公民館前の広場（雨天は公民館）", 21)
    s.print((46, 122), "10月9日（金）までに班長へ。Web でも答えられます。", 21)
    s.print((46, 180), "世帯名", 26)
    s.line((150, 226), (940, 226))
    s.hand((160, 176), hh, 42, ink)
    s.print((46, 262), "来場", 26)
    s.print((150, 262), "大人", 26)
    s.rect((212, 250, 292, 312))
    s.print((302, 262), "人", 26)
    s.print((400, 262), "子ども", 26)
    s.rect((498, 250, 578, 312))
    s.print((588, 262), "人", 26)
    s.hand((232, 250), str(adults), 46, ink)
    s.hand((518, 250), str(children), 46, ink)
    s.print((46, 340), "手伝い", 26)
    s.print((150, 342), "できる時間帯に○をつけてください", 21)
    pos = [(150, 392), (500, 392), (150, 450), (500, 450)]
    for (x, y), label in zip(pos, HELP_OPTIONS):
        s.print((x, y), label, 28)
    if slot is not None:
        x, y = pos[slot]
        wlen = P.text_width(HELP_OPTIONS[slot], 28)
        s.hand_circle(x + wlen / 2, y + 17, wlen / 2 + 24, 30, ink=ink)
    s.print((46, 524), "お名前", 26)
    s.line((150, 568), (600, 568))
    if help_name:
        s.hand((160, 516), help_name, 40, ink)
    s.print((46, 596), "ひとこと", 26)
    s.line((150, 640), (940, 640))
    if note:
        s.hand((160, 590), note, 36, ink)
    s.print((46, 656), "加入の有無は書かなくて構いません。手伝いだけの参加もできます。", 18, fill=(90, 90, 90))
    return s


def write_answer_photos() -> None:
    kimura = answer_slip(11, "2班", K + "木村", 2, 1, K + "木村あき", 3, "9時の設営は出られません", P.BLUE_INK)
    ishikawa = answer_slip(12, "2班", K + "石川", 1, 0, None, None, "", P.BLACK_INK)
    ikeda = answer_slip(13, "2班", K + "池田", 2, 0, K + "池田みのり", 2, "", P.BLUE_INK)
    save_photo(scene_multi([kimura, ishikawa, ikeda], 101, "wood"), "this-year/answers/回答票_2班.jpg")
    fujii = answer_slip(14, "3班", K + "藤井", 1, 0, None, None, "", P.BLACK_INK)
    nishimura = answer_slip(15, "3班", K + "西村", 2, 2, K + "西村しの", 0, "子どもは小学生です", P.BLUE_INK)
    save_photo(scene_multi([fujii, nishimura], 102, "white"),
               "this-year/answers/回答票_3班.jpg")


# ---- 領収書とレシート ----

def receipt_form(seed: int, date_s: str, amount: int, purpose: str, issuer: str, ink) -> P.Sheet:
    rng = random.Random(seed)
    s = P.Sheet(1000, 560, rng, paper=(246, 242, 232))
    s.rect((14, 14, 986, 546), width=3, outline=(150, 70, 70))
    s.print((380, 36), "領 収 書", 52, bold=True, fill=(120, 40, 40))
    s.print((60, 120), "宛名", 26)
    s.line((140, 164), (700, 164), fill=(150, 70, 70))
    s.hand((150, 112), f"{WARD} 実行委員会", 40, ink)
    s.hand((700, 112), "様", 40, ink)
    s.print((60, 210), "金額", 26)
    s.rect((140, 196, 700, 280), width=3, outline=(150, 70, 70))
    s.hand((170, 200), f"¥ {amount:,} -", 56, ink)
    s.print((60, 316), "但し", 26)
    s.line((140, 358), (900, 358), fill=(150, 70, 70))
    s.hand((150, 306), purpose, 38, ink)
    s.print((60, 400), "上記正に領収いたしました。", 24)
    s.hand((60, 450), date_s, 36, ink)
    s.print((560, 440), "発行", 24)
    s.hand((630, 424), issuer, 38, ink)
    s.seal(880, 470, 44, f"{issuer[-2:]}\n印")
    return s


def thermal_receipt(seed: int, lines: list[tuple[str, str]], total: int, store: str, when: str) -> P.Sheet:
    rng = random.Random(seed)
    h = 360 + 52 * len(lines) + 260
    s = P.Sheet(560, h, rng, paper=(252, 252, 250))
    s.print((100, 30), store, 34, bold=True)
    s.print((60, 90), when, 24)
    s.print((60, 124), "------------------------------", 22)
    y = 170
    for name, price in lines:
        s.print((50, y), name, 26)
        s.print((560 - 60 - P.text_width(price, 26), y), price, 26)
        y += 52
    s.print((60, y), "------------------------------", 22)
    y += 44
    s.print((50, y), "合計", 30, bold=True)
    tot = f"{total:,}"
    s.print((560 - 60 - P.text_width(tot, 30, P.PRINT_BOLD), y), tot, 30, bold=True)
    y += 54
    s.print((50, y), f"（内消費税 {total * 10 // 110:,}）", 22)
    y += 44
    s.print((50, y), "ありがとうございました", 22)
    return s


def write_receipts() -> None:
    save_photo(scene_single(receipt_form(21, "2025年10月25日", 12000, "収穫祭の食材代として",
                                         K + "商店C", P.BLACK_INK), 201, "wood", canvas=(1500, 1250), fill=0.90),
               "last-year/accountant/領収_その1.jpg")
    save_photo(scene_single(receipt_form(22, "2026年10月22日", 14500, "収穫祭の食材代として",
                                         K + "商店C", P.BLUE_INK), 202, "white", canvas=(1500, 1250), fill=0.90),
               "this-year/day/領収書_今年_食材.jpg")
    th = thermal_receipt(23, [("紙コップ 100個", "1,200"), ("紙皿 50枚", "900"), ("割りばし 100膳", "600"),
                              ("ごみ袋 10枚", "1,100")], 3800, K + "文具店E", "2026/10/22 15:42")
    save_photo(scene_single(th, 203, "wood", canvas=(1100, 1700), fill=0.80, angle=-3.0),
               "this-year/day/レシート_今年_文具.jpg")


# ---- 去年の協賛控え ----

def write_sponsor_last_year() -> None:
    rng = random.Random(31)
    s = P.Sheet(1240, 1754, rng, paper=(250, 249, 244))
    s.lined_paper(top=190, gap=64)
    ink = P.BLUE_INK
    s.hand((120, 56), "2025 協賛  (会計)", 56, ink, bold=True)
    s.hand((120, 150), "10/20 受け取り分の控え", 36, P.PENCIL)
    cols = [120, 620, 880]
    s.hand((cols[0], 214), "事業所", 38, ink)
    s.hand((cols[1], 214), "金額", 38, ink)
    s.hand((cols[2], 214), "受け取り", 38, ink)
    rows = [(f"{K}商店A", "5,000", "10/20 済"), (f"{K}農園B", "3,000", "10/20 済"),
            (f"{K}食堂C", "見送り", ""), (f"{K}工房D", "返事なし", "")]
    y = 214 + 64
    for name, amt, rcv in rows:
        s.hand((cols[0], y), name, 40, ink)
        s.hand((cols[1], y), amt, 40, ink)
        if rcv:
            s.hand((cols[2], y), rcv, 38, ink)
        y += 64
    s.hand_line((110, y + 10), (1130, y + 8), 3, ink)
    s.hand((cols[0], y + 24), "計", 44, ink)
    s.hand((cols[1], y + 24), "8,000 円", 44, ink)
    s.hand((120, y + 190), f"窓口 {K}井上 000-0000-0103", 38, ink)
    s.hand((120, y + 270), "金額と電話は役員だけ。", 36, P.PENCIL)
    s.hand_circle(cols[1] + 100, y + 56, 150, 44, ink=P.RED_INK)
    save_photo(scene_single(s, 301, "wood", crease=2), "last-year/accountant/IMG_2081.jpg")


def write_sponsor_this_year() -> None:
    rng = random.Random(32)
    s = P.Sheet(1240, 1754, rng)
    s.print((80, 70), "秋の収穫祭 協賛先の一覧（役員用）", 44, bold=True)
    s.print((80, 140), "返事と額の欄に書いてください。可・不可・未のどれかに○。", 26)
    s.print((80, 180), "金額は役員の範囲です。公開の案内には出ません。", 22, fill=(90, 90, 90))
    xs = [80, 480, 720, 950, 1160]
    top = 250
    heads = ["事業所名", "去年の額", "返事", "今年の額"]
    for x, t in zip(xs, heads):
        s.print((x + 14, top + 16), t, 28, bold=True)
    rows = [(f"{K}商店A", "5,000円"), (f"{K}農園B", "3,000円"), (f"{K}食堂C", "-"), (f"{K}工房D", "-")]
    rh = 140
    for i, (n, last) in enumerate(rows):
        y = top + 64 + i * rh
        s.print((xs[0] + 14, y + 44), n, 30)
        s.print((xs[1] + 14, y + 44), last, 30)
        s.print((xs[2] + 20, y + 54), "可 ・ 不可 ・ 未", 24)
    for i in range(len(rows) + 2):
        y = top + (0 if i == 0 else 64 + (i - 1) * rh)
        s.line((xs[0], y), (xs[-1], y), 2)
    for x in xs:
        s.line((x, top), (x, top + 64 + len(rows) * rh), 2)
    ink = P.BLACK_INK
    ys = [top + 64 + i * rh for i in range(4)]
    s.hand_circle(xs[2] + 36, ys[0] + 66, 30, 26, ink=ink)
    s.hand((xs[3] + 20, ys[0] + 36), "6,000", 44, ink)
    s.hand_circle(xs[2] + 36, ys[1] + 66, 30, 26, ink=ink)
    s.hand((xs[3] + 20, ys[1] + 36), "3,000", 44, ink)
    s.hand_circle(xs[2] + 108, ys[2] + 66, 40, 26, ink=ink)
    s.hand((xs[3] + 20, ys[2] + 40), "-", 40, ink)
    s.hand_circle(xs[2] + 196, ys[3] + 66, 30, 26, ink=ink)
    s.hand((xs[3] + 6, ys[3] + 44), "電話まだ", 32, ink)
    s.hand((80, ys[3] + rh + 40), "9/17 電話  会計", 38, ink)
    s.hand((80, ys[3] + rh + 110), "商店Aは去年より1,000円増", 36, ink)
    save_photo(scene_single(s, 302, "wood", crease=2), "this-year/accountant/協賛先の一覧_今年の返事.jpg")


# ---- 配置の図 ----

def draw_site(s: P.Sheet, ink, plan: str) -> None:
    """広場と建物の見取り図。plan は 'last' か 'sunny'。"""
    s.hand_rect((90, 330, 1150, 1000), 3.6, ink)
    s.hand((110, 345), "広場", 44, ink)
    s.hand_rect((90, 1100, 1150, 1560), 3.6, ink)
    s.hand((110, 1115), "公民館", 44, ink)
    s.hand_rect((130, 1190, 560, 1520), 3.2, ink)
    s.hand((150, 1205), "ホール", 38, ink)
    s.hand_rect((640, 1190, 1110, 1520), 3.2, ink)
    s.hand((660, 1205), "集会室", 38, ink)
    s.hand_line((560, 1040), (560, 1100), 3.2, ink)
    s.hand((600, 1030), "入口", 36, ink)
    s.hand_arrow((560, 1000), (560, 1100), 3.0, ink)
    s.hand_rect((170, 760, 380, 900), 3.2, ink)
    s.hand((190, 790), "豚汁", 38, ink)
    s.hand_rect((430, 760, 640, 900), 3.2, ink)
    s.hand((440, 790), "おにぎり", 36, ink)
    s.hand_rect((690, 760, 900, 900), 3.2, ink)
    s.hand((700, 790), "焼き芋", 38, ink)
    if plan == "sunny":
        s.hand_rect((930, 760, 1110, 900), 3.2, ink)
        s.hand((940, 790), "輪投げ", 36, ink)
        s.hand_rect((170, 450, 480, 620), 3.2, ink)
        s.hand((190, 470), "品評・抽選", 38, ink)
        s.hand_rect((700, 470, 920, 620), 3.2, ink)
        s.hand((730, 490), "受付", 40, ink)
    else:
        s.hand_rect((700, 470, 920, 620), 3.2, ink)
        s.hand((730, 490), "受付", 40, ink)


def write_site_last_year() -> None:
    rng = random.Random(41)
    s = P.Sheet(1240, 1754, rng, paper=(250, 249, 244))
    ink = P.BLACK_INK
    s.hand((90, 60), "2025 配置のメモ", 52, ink, bold=True)
    s.hand((90, 150), "10/18  副会長", 36, P.PENCIL)
    s.hand((90, 220), "晴れ → 広場に模擬店。受付は入口のそば。", 36, ink)
    s.hand((90, 270), "雨の時は建物 (机と椅子の置き方は未確認)", 36, ink)
    draw_site(s, ink, "last")
    s.hand((90, 1610), f"担当 {K}井上  000-0000-0103", 38, ink)
    save_photo(scene_single(s, 401, "wood", crease=2), "last-year/vice-chair/配置のメモ.jpg")


def write_site_this_year() -> None:
    rng = random.Random(42)
    s = P.Sheet(1240, 1754, rng, paper=(250, 249, 244))
    ink = P.BLUE_INK
    s.hand((90, 60), "2026 配置 (晴れの時)", 52, ink, bold=True)
    s.hand((90, 150), "10/15  実行委員長が決めた", 36, P.PENCIL)
    s.hand((90, 220), "焼き芋は火を使うので端のテント", 36, ink)
    s.hand((90, 270), "避難口の前は空ける", 36, ink)
    draw_site(s, ink, "sunny")
    save_photo(scene_single(s, 402, "white", crease=2), "this-year/rota/配置図_今年の晴天.jpg")


# ---- 当番表 ----

def rota_sheet(seed: int, title: str, sub: str, rows: list[tuple[str, str, str]]) -> tuple[P.Sheet, list[int]]:
    rng = random.Random(seed)
    s = P.Sheet(1240, 1754, rng)
    s.print((80, 70), title, 44, bold=True)
    s.print((80, 140), sub, 24, fill=(90, 90, 90))
    xs = [80, 330, 700, 1160]
    top = 220
    for x, t in zip(xs, ["時間", "仕事", "担当（書き込む）"]):
        s.print((x + 14, top + 14), t, 28, bold=True)
    rh = 190
    ys = []
    for i, (t, work, _) in enumerate(rows):
        y = top + 64 + i * rh
        ys.append(y)
        s.print((xs[0] + 14, y + 20), t, 26)
        s.print((xs[1] + 14, y + 20), work, 28)
    for i in range(len(rows) + 2):
        y = top if i == 0 else top + 64 + (i - 1) * rh
        s.line((xs[0], y), (xs[-1], y), 2)
    for x in xs:
        s.line((x, top), (x, top + 64 + len(rows) * rh), 2)
    return s, ys


def write_rota_decided() -> None:
    rows = [("9:00-10:30", "テント設営", ""), ("10:30-12:00", "受付", ""),
            ("12:00-14:00", "模擬店", ""), ("14:00-15:00", "片付け", "")]
    s, ys = rota_sheet(51, "2026年 秋の収穫祭 当番表（案）", "手伝いの申し出から決めて書き込む", rows)
    ink = P.BLUE_INK
    x = 710
    s.hand((x, ys[0] + 20), f"{K}井上、{K}加藤", 38, ink)
    s.hand((x, ys[0] + 90), f"{K}西村しの", 38, ink)
    s.hand((x, ys[1] + 20), f"{K}小林さと", 38, ink)
    s.hand((x, ys[1] + 90), f"{K}橋本", 38, ink)
    s.hand((x, ys[2] + 20), f"{K}池田みのり", 38, ink)
    s.hand((x, ys[2] + 90), f"{K}高橋 ?   {K}渡辺", 38, ink)
    s.hand((x, ys[3] + 20), f"{K}川口ゆうき", 38, ink)
    s.hand((x, ys[3] + 90), f"{K}木村あき(14:30から)", 36, ink)
    s.hand((80, ys[3] + 230), "10/15 実行委員長 " + K + "井上", 38, P.BLACK_INK)
    s.hand((80, ys[3] + 300), "高橋さんは返事待ち", 36, P.PENCIL)
    save_photo(scene_single(s, 501, "wood", crease=2), "this-year/rota/当番表_実行委員長の書込み.jpg")


def write_rota_day() -> None:
    rows = [("9:00-10:30", "設営（机と椅子）", ""), ("10:30-14:00", "入口の誘導と傘置き", ""),
            ("10:30-12:00", "受付", ""), ("12:00-14:00", "模擬店（入口と軒下）", ""),
            ("14:00-15:00", "片付け", "")]
    s, ys = rota_sheet(52, "2026年10月24日 当番表（雨天会場 版2）", "公民館 ホールと集会室", rows)
    ink = P.BLACK_INK
    x = 710

    def names(y, items):
        yy = y + 14
        for n, absent in items:
            end = s.hand((x, yy), n, 34, ink)
            if absent:
                s.hand_cross(end + 14, yy + 2, 30, ink=P.RED_INK)
                s.hand((end + 56, yy), "欠", 30, P.RED_INK)
            else:
                s.hand_circle((x + end) / 2, yy + 22, (end - x) / 2 + 18, 26, 2.8, P.RED_INK)
            yy += 56
    names(ys[0], [(f"{K}井上", False), (f"{K}加藤", False), (f"{K}西村しの", False)])
    s.hand((x, ys[1] + 40), "傘置き  " + K + "田中", 36, ink)
    s.hand((x, ys[1] + 100), "(当日 書き足し)", 28, P.PENCIL)
    names(ys[2], [(f"{K}小林さと", False), (f"{K}橋本", False)])
    names(ys[3], [(f"{K}池田みのり", False), (f"{K}高橋", True), (f"{K}渡辺", False)])
    names(ys[4], [(f"{K}川口ゆうき", False), (f"{K}木村あき", False)])
    s.hand((80, ys[4] + 230), "余白: 入口の案内のぼりは公民館から借りた", 34, P.PENCIL)
    save_photo(scene_single(s, 502, "wood", crease=2), "this-year/day/当番表_当日の書込み.jpg")


# ---- 役員会のメモと市の通知 ----

def write_meeting_memo() -> None:
    rng = random.Random(61)
    s = P.Sheet(980, 1360, rng, paper=(251, 250, 245))
    s.lined_paper(top=130, gap=62)
    ink = P.BLUE_INK
    lines = [
        "9/12 (土) 役員会",
        "秋の収穫祭 2026",
        "日時  10/24 (土) 11:00-14:00",
        "場所  公民館前の広場",
        "雨天  ホールと集会室 (時間は同じ)",
        "催し  豚汁 焼き芋 新米おにぎり",
        "      輪投げ 品評 抽選",
        "手伝い 設営 受付 模擬店 片付け",
        "      未加入の人もOK",
        "回答  班長の紙と Web  10/9まで",
        "連絡先 festival@example.invalid",
        "会長 可 (9/12)",
        "去年の役員は今年の承諾ではない",
        "公民館の予約は 副会長が電話",
    ]
    for i, ln in enumerate(lines):
        s.hand((104, 130 + i * 62 - 52), ln, 38, ink if i else P.BLACK_INK, bold=(i == 0))
    save_photo(scene_single(s, 601, "wood", canvas=(1500, 1900), crease=1), "this-year/meeting/役員会のメモ.jpg")


def write_city_notice() -> None:
    rng = random.Random(62)
    s = P.Sheet(1240, 1754, rng, paper=(252, 251, 247))
    s.print((820, 100), "2026年8月25日", 26, mincho=True)
    s.print((100, 190), "各区長 様", 32, mincho=True)
    s.print((700, 270), f"{CITY} 地域活動担当", 28, mincho=True)
    s.print((180, 400), "秋の地域行事の予定のお知らせのお願い", 38, bold=True)
    y = 500
    for para in [
        "秋の行事の予定を、9月末までにお知らせください。",
        "連絡先は、公開できる窓口をお書きください。",
        "また、会場の出入口を空け、雨天の場合の案内を事前に周知してください。",
    ]:
        s.print((120, y), para, 30, mincho=True)
        y += 64
    s.print((120, y + 30), "記", 30, mincho=True)
    s.print((160, y + 100), "1 回答期限  2026年9月30日", 30, mincho=True)
    s.print((160, y + 164), f"2 問い合わせ  {CITY} 地域活動担当（内線 000）", 30, mincho=True)
    s.print((100, 1600), "全て架空の資料です。実在の自治体の通知ではありません。", 22, fill=(100, 100, 100))
    s.seal(1050, 330, 52, "架空\n市印")
    save_photo(scene_single(s, 602, "dark", crease=2), "this-year/chair/市からの通知.jpg")


# ---------------------------------------------------------------- 今年: 文の入力

def write_texts() -> None:
    write_text("this-year/meeting/電話の結果_公民館.txt",
               "全て架空。2026年9月14日（月）書記の記録。\n"
               "副会長が公民館に電話。10月24日（土）の公民館前の広場と、雨の時のホールと集会室を、\n"
               "9時から15時まで押さえられたと聞いた。使用許可の紙は後日受け取る。")
    write_text("this-year/answers/電話_木村の訂正.txt",
               f"全て架空。2026年10月6日（火）18時10分ごろ、書記の自宅の電話を家族が受けた分を、書記が文にした。\n"
               f"2班の{K}木村あきさんから、書記あての伝言。\n"
               "10月5日に班長へ出した紙の回答のうち、手伝いの片付けを「14時から」と書いたが、\n"
               "「14時30分から15時」に直してほしい。来場は大人2人と子ども1人のまま変わらない。\n"
               "別の世帯が増える話ではない、と本人が言っていた。（家族のメモには「14時半」とあった）")
    write_text("this-year/answers/電話_田中.txt",
               f"全て架空。2026年10月6日（火）19時05分ごろ、書記の自宅の電話を家族が受けた分を、書記が文にした。\n"
               f"3班の{K}田中さんから、書記あての伝言。\n"
               "来場は1人。午前の設営は出られない。受付は出られるかまだ分からない。\n"
               "下の名前と住所は聞いていない。")
    write_text("this-year/rain/10月23日_雨天の判断.txt",
               "全て架空。2026年10月23日（金）17時、書記の記録。\n"
               "会長が予報を見て、明日の収穫祭は予め案内した公民館のホールと集会室で行うと決めた。\n"
               "日時は2026年10月24日11時から14時のまま。翌日へ順延しない。\n"
               "副会長が配置と中身を確認した。豚汁とおにぎりは入口と軒下、品評と抽選はホール、輪投げは集会室。\n"
               "焼き芋は雨と火の扱いのため中止。屋外のテントは立てない。\n"
               "設営の仕事は、テントから机と椅子の配置に変わる。入口の誘導と傘置きが新しく要る。\n"
               "入口の誘導と傘置きを誰が受け持つかは、まだ決まっていない。\n"
               "知らせるのは、雨天会場で実施、時間は同じ、焼き芋は中止、輪投げは集会室、の四つ。\n"
               "配置と当番の組み直しは実行委員と班長に。個人の連絡先と協賛の金額は外に出さない。\n"
               "紙は差し替える。班長には書記が電話で伝える。")
    write_text("this-year/day/会計メモ_今年.txt",
               "全て架空。2026年10月26日（月）会計の記録。\n"
               f"領収書は2枚（{K}商店Cの食材代14,500円、{K}文具店Eの紙コップなど3,800円）。\n"
               "ほかに、領収書の無い立て替えが2,700円（のぼりの布、ガムテープ）あり。\n"
               "支出は全部で21,000円。協賛は今年の返事のとおり、商店A 6,000円と農園B 3,000円で計9,000円。\n"
               "現金の残りは会計が預かっている。")


def write_web_and_line() -> None:
    write_json("this-year/answers/Web回答.json", {
        "説明": "全て架空。区のページの回答の入口に入れる内容（世帯名、班、人数、手伝いは名前と時間帯の別の欄）。"
                "製品の API の形ではなく、確かめる手が画面に入力する時の控え。",
        "answers": [
            {"控え": "W1", "入れる日時": "2026-10-04T19:00:00+09:00", "世帯名": K + "小林", "班": "1班",
             "大人": 2, "子ども": 0, "手伝い": {"名前": K + "小林さと", "時間帯": "受付 10:30-12:00"}},
            {"控え": "W2", "入れる日時": "2026-10-05T20:00:00+09:00", "世帯名": K + "田中", "班": "3班",
             "大人": 1, "子ども": 0, "手伝い": {"名前": "", "時間帯": "未定"}},
            {"控え": "W3", "入れる日時": "2026-10-08T21:30:00+09:00", "世帯名": K + "川口", "班": "2班",
             "大人": 2, "子ども": 1, "手伝い": {"名前": K + "川口ゆうき", "時間帯": "片付け 14:00-15:00"}},
        ],
        "メモ": "W3 の世帯は加入していない。班は一番近い班を選んだ。",
    })
    t = lambda m, d, h, mi: int(dt.datetime(2026, m, d, h, mi, tzinfo=JST).timestamp() * 1000)
    uid = lambda n: "U" + f"{n:032x}"
    msgs = [
        (uid(0xA1), t(10, 6, 20, 15), f"2班の{K}橋本です。大人2人と子ども1人で行きます。受付なら手伝えます。"),
        (uid(0xA2), t(10, 6, 21, 2), "スーパーの特売、卵が今日は一人二パックまでだそうです。"),
        (uid(0xA3), t(10, 7, 8, 40),
         f"犬の散歩で転んで膝を打ちました（笑）。あ、収穫祭は3班の{K}中川で、大人2人子ども1人で行きます。"),
    ]
    events = []
    for i, (u, ts, text) in enumerate(msgs, 1):
        events.append({
            "type": "message", "mode": "active", "timestamp": ts,
            "webhookEventId": f"01FICTIONAL{i:016d}", "deliveryContext": {"isRedelivery": False},
            "source": {"type": "user", "userId": u},
            "replyToken": f"{i:032x}",
            "message": {"type": "text", "id": f"{10000000000000 + i}", "quoteToken": f"fictional-quote-{i}", "text": text},
        })
    write_json("this-year/answers/LINE_webhook.json", {"destination": uid(0xD0), "events": events})
    write_text("this-year/answers/LINE_返事.txt",
               "全て架空。区の公式 LINE（検証用のアカウント）に、住民から一対一で届いた文。\n"
               "LINE_webhook.json は、同じ三通を LINE の webhook の形にした物（署名は付けていない。\n"
               "ローカルで試す時は、検証用の鍵で署名を付けて送る）。本物の住民には送らない。\n\n"
               f"1. 10月6日 20:15  2班の{K}橋本。大人2人、子ども1人。受付なら手伝える。（収穫祭の答え）\n"
               "2. 10月6日 21:02  スーパーの卵の特売の話。（収穫祭に関係しない雑談）\n"
               f"3. 10月7日 08:40  犬の散歩の話に続けて、3班の{K}中川が大人2人、子ども1人で行く。（雑談の中に答えが混ざる）")




def _check_story() -> None:
    """通しの筋が名簿と食い違わないことを確かめる。"""
    unique = [("1班", "小林"), ("1班", "井上"), ("1班", "加藤"), ("2班", "木村"), ("2班", "石川"),
              ("2班", "池田"), ("2班", "橋本"), ("3班", "藤井"), ("3班", "西村"), ("3班", "中川")]
    for g, sname in unique:
        n = sum(1 for r in ROSTER if r["班"] == g and r["世帯名"] == K + sname)
        assert n == 1, (g, sname, n)
    assert sum(1 for r in ROSTER if r["世帯名"] == K + "田中") == 2  # 同じ名字が二世帯
    assert not any(r["世帯名"] == K + "川口" for r in ROSTER)  # 名簿に当たらない答え
    for _g, name, *_ in COMMITTEE_2025:
        assert any(r["世帯名"] == K + name for r in ROSTER), name


# ---------------------------------------------------------------- 実行

def main() -> None:
    _check_story()
    sys.stdout.reconfigure(encoding="utf-8")  # Windows の既定の文字コードで化けないように
    write_roster()
    write_secretary()
    write_committee_xlsx()
    write_rota_pdf()
    write_receipts()
    write_sponsor_last_year()
    write_site_last_year()
    write_city_notice()
    write_meeting_memo()
    write_sponsor_this_year()
    write_answer_photos()
    write_site_this_year()
    write_rota_decided()
    write_rota_day()
    write_texts()
    write_web_and_line()
    n = sum(1 for p in ROOT.rglob("*") if p.is_file() and "build" not in p.parts)
    print(f"作成: {n} ファイル ({ROOT})")


if __name__ == "__main__":
    main()
