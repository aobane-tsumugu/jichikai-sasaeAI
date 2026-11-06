"""行事以外の架空資料。既存の紙・Wordの生成部品を使う。実在の資料は読まない。"""
from __future__ import annotations

import json
import random
import subprocess

import build_fixtures as B
import paper as P


def materials():
    # 通しが照合する値を直接読む。日本語の決定・未決・名前を二重に管理しない。
    source = """
import { kindsMaterial } from './test/fixtures/kinds.ts';
import { meetingMaterial } from './scripts/walkthrough-meeting.ts';
import { KIND_FILES, KINDS_FIXTURE_YEAR, MEETING_FIXTURE_NOW } from './test/fixtures/kinds-files.ts';
console.log(JSON.stringify({
  kinds: kindsMaterial(KINDS_FIXTURE_YEAR),
  meeting: meetingMaterial(new Date(MEETING_FIXTURE_NOW)),
  files: KIND_FILES
}));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", source],
                            cwd=B.ROOT.parent, check=True, capture_output=True, encoding="utf-8")
    return json.loads(result.stdout)


def word(path, title, text, notes=()):
    blocks = [("p", "全て架空です。実在の人や資料を写していません。")]
    blocks += [("p", line) for line in text.splitlines() if line]
    blocks += [("p", line) for line in notes]
    B.make_docx("kinds/" + path, title, blocks)


def workbook(path, title, rows, widths):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.worksheet.page import PageMargins
    import datetime as dt

    wb = Workbook()
    ws = wb.active
    ws.title = title
    for row in rows:
        ws.append(row)
    edge = Side(style="thin", color="D9D9D9")
    for row in ws:
        for cell in row:
            cell.font = Font(name="MS Gothic", size=14, color="000000")
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            cell.border = Border(left=edge, right=edge, top=edge, bottom=edge)
        ws.row_dimensions[row[0].row].height = 34
    for cell in ws[1]:
        cell.font = Font(name="MS Gothic", size=14, bold=True, color="000000")
        cell.fill = PatternFill("solid", fgColor="E5E5E5")
    for index, width in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(1, index).column_letter].width = width
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 1
    ws.page_margins = PageMargins(left=0.5, right=0.5, top=0.6, bottom=0.6, header=0.2, footer=0.2)
    ws.print_options.horizontalCentered = True
    ws.print_area = ws.dimensions
    wb.properties.creator = "架空資料の作成用"
    wb.properties.created = wb.properties.modified = dt.datetime(2026, 11, 7)
    wb.save(B.out("kinds/" + path))


def photo(path, title, lines, seed, handwriting=False):
    sheet = P.Sheet(1240, 1754, random.Random(seed))
    if handwriting:
        sheet.lined_paper(top=250, gap=66)
    sheet.print((65, 55), "全て架空です。プログラムで作った合成画像です。", 27)
    sheet.print((65, 120), title, 42, bold=True)
    y = 225
    for line in lines:
        if handwriting:
            # 明示した改行の範囲で収め、一字ずつ傾きと位置をずらす。
            sheet.hand((105, y), line, size=35)
            y += 66
        else:
            y = sheet.print_wrapped((70, y), line, 32, 1100, line_gap=1.6) + 15
    if y > 1630:
        raise ValueError("紙の本文が収まりません: " + path)
    B.save_photo(B.scene_single(sheet, seed, crease=1), "kinds/" + path)


def city_pdf(path, city, year):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("KindsBIZ", str(P.FONT_DIR / P.PRINT), subfontIndex=0))
    c = canvas.Canvas(str(B.out("kinds/" + path)), pagesize=A4, invariant=1)
    c.setTitle("架空の市の通知")
    c.setAuthor("架空資料の作成用")
    y = A4[1] - 55
    for index, line in enumerate([
        "全て架空です。実在の自治体や資料を写していません。",
        "架空の市の通知", *city.splitlines(), "",
        "問い合わせ：架空の地域担当窓口",
        "000-0000-0351  city@example.invalid", "",
        f"同封された去年の控え：{year - 1}年3月31日提出済み。",
        "去年の記入者：架空旧担当五郎。今年の回答者ではありません。",
    ]):
        c.setFont("KindsBIZ", 18 if index == 1 else 12)
        c.drawString(42, y, line)
        y -= 44 if index == 1 else 31
    c.showPage()
    c.save()


def write_kinds():
    material = materials()
    k, m, files = material["kinds"], material["meeting"], material["files"]
    y = k["year"]
    # 去年の総会の資料と今年の準備は混ぜたまま送るが、紙の中の年は分ける。
    meeting_year = m["year"]
    last = meeting_year - 1
    word(files["meetingAgenda"][0], f"架空の区 {last}年総会の議案書",
         f"{last}年1月6日10時、架空の集会室。\n"
         "議案：清掃活動の回数、遊具の更新。\n"
         "去年の議案書です。今年の日程や決定ではありません。",
         ["去年の記録係：架空旧担当五郎。担当済みです。",
          "連絡先の控え：000-0000-0350 meeting@example.invalid"])
    workbook(files["meetingAgenda"][1], "去年の決算", [
        ["費目", f"{last}年の収入（円）", f"{last}年の支出（円）"],
        ["会費", 120000, 0], ["清掃活動", 0, 30000], ["集会室の維持", 0, 50000],
        ["合計", 120000, 80000], ["翌年へ繰り越す額", 40000, ""],
        ["全て架空", "去年の決算", "今年の予算ではありません"],
        [f"{last}年12月31日", "架空会計六郎", "担当済み"],
    ], [27, 25, 27])
    photo(files["meetingAgenda"][2], f"架空の区 {last}年総会 議事録", [
        f"{last}年1月6日10時、架空の集会室。",
        "清掃活動の回数と遊具の更新を話し合いました。",
        "前回の記録です。今年の決定ではありません。",
        "記録係：架空旧担当五郎（担当済み）。",
        "000-0000-0350 meeting@example.invalid",
    ], 3501)
    word(files["meetingAgenda"][3], "架空の区 今年の総会の資料", m["agenda"])
    # 今年の議事録を作る段では今年の紙を送る。前年の紙を今年として読み替えない。
    photo(files["meetingMinutes"][0], "架空の区 今年の総会の記録", [
        *m["minutes"].splitlines(),
    ], 3502)

    agenda = k["agenda"].splitlines()
    photo(files["boardAgenda"][0], "架空の区 役員会 議題の紙", [
        agenda[0], agenda[1], "議題は清掃用具の共同購入と",
        "遊具の更新です。まだ決めていません。",
        "", f"去年の控え：{y - 1}年1月10日。",
        "架空旧担当五郎（担当済み）。",
        "000-0000-0352", "board@example.invalid",
    ], 3503, handwriting=True)
    word(files["boardMinutes"][0], "架空の区 役員会 議事のメモ", k["minutes"])
    word(files["boardNextMinutes"][0], "架空の区 次の役員会 議事のメモ", k["nextMinutes"])

    duty_rows = [line.split("\t") for line in k["duty"].splitlines()[1:]]
    workbook(files["duty"][0], "去年の当番", [
        *duty_rows,
        ["全て架空", f"{y - 1}年の当番表", "今年の承諾ではありません"],
        [f"{y - 1}年12月31日", "上の当番は担当済み", ""],
    ], [18, 31, 29])
    photo(files["duty"][1], f"架空の区 {y - 1}年 掲示の当番表", [
        "時間帯 ／ 持ち場 ／ 担当",
        *[f"{slot} ／ {k['task']} ／ {name}" for slot, name in
          zip(k["slots"], [k["names"]["retained"], k["names"]["exempt"], k["names"]["departed"]])],
        f"{y - 1}年12月31日までの掲示。上の当番は担当済み。",
        "今年の担当を引き受けたことにはなりません。",
        "問い合わせ：架空当番係七郎 000-0000-0353",
        "duty@example.invalid",
    ], 3504)

    city_pdf(files["city"][0], k["city"], y)
    word(files["city"][1], "架空の区 集会室の設備の回答の様式",
         f"提出先：架空の地域担当窓口\n提出期限：{y}年3月31日\n"
         "照明の数：＿＿個\n交換の希望の有無：希望あり・希望なし\n"
         "記入者：＿＿＿＿\nまだ回答を書いていない様式です。",
         [f"同封の控え：{y - 1}年3月31日提出済み。架空旧担当五郎。",
          "今年の回答欄は空欄です。去年の数や希望を転記しないでください。",
          "問い合わせ：000-0000-0351 city@example.invalid"])
    print("種類ごとの資料を作成: " + str(sum(len(paths) for paths in files.values())) + "点")


if __name__ == "__main__":
    write_kinds()
