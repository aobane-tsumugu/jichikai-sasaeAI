# -*- coding: utf-8 -*-
"""作った資料を開き直して確かめる。

- docx は zip の中の XML を読み、形が正しいかと本文の字を見る
- xlsx は openpyxl で読み直す
- pdf は fitz で字を取り出す
- jpg は大きさと EXIF を見る（見た目は別に目で確かめる）
- 書いてはいけない言葉、字化け、実在の地名や会社名の候補を探す
- 中身が少しだけ違う三組の違いと日付を読み直す

実行: python -X utf8 check.py
"""
import difflib
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

import fitz
import openpyxl
from PIL import Image

from common import BASE, DIR_REL, DIR_UNREL

BANNED = ["架空", "テスト", "サンプル"]
MOJIBAKE = [chr(0xFFFD), chr(0xA0), chr(0x2011), "縺", "繧", "繝", "譁", "ã", "Ã", "â€"]  # 字化けと、取り出すと別の字になる空白とハイフン
REAL_NAMES = ["東京", "大阪", "京都", "北海道", "横浜", "名古屋", "札幌", "福岡",
              "神戸", "埼玉", "千葉", "愛知", "岐阜", "熊本", "都道府県", "県", "パナソニック", "シャープ",
              "東芝", "日立", "ソニー", "イオン", "セブン", "ローソン", "ファミリーマート", "楽天", "アマゾン"]
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(path):
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith(".xml") or n.endswith(".rels"):
                ET.fromstring(z.read(n))  # 形が正しいか
        root = ET.fromstring(z.read("word/document.xml"))
        core = z.read("docProps/core.xml").decode("utf-8")
    paras = []
    for p in root.iter(W + "p"):
        paras.append("".join((t.text or "") for t in p.iter(W + "t")))
    created = re.search(r"<dcterms:created[^>]*>([^<]+)<", core).group(1)
    modified = re.search(r"<dcterms:modified[^>]*>([^<]+)<", core).group(1)
    return "\n".join(paras), {"created": created, "modified": modified}


def xlsx_text(path):
    wb = openpyxl.load_workbook(path)
    lines = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            vals = ["" if v is None else str(v) for v in row]
            if any(vals):
                lines.append("\t".join(vals))
    pr = wb.properties
    return "\n".join(lines), {"created": str(pr.created), "modified": str(pr.modified), "creator": pr.creator}


def pdf_text(path):
    doc = fitz.open(path)
    t = "\n".join(pg.get_text() for pg in doc)
    meta = {"pages": len(doc), "created": doc.metadata.get("creationDate"), "fonts": sorted({f[3] for pg in doc for f in pg.get_fonts()})}
    doc.close()
    return t, meta


def jpg_info(path):
    im = Image.open(path)
    ex = im.getexif()
    sub = ex.get_ifd(0x8769)
    return {"size": im.size, "mode": im.mode, "DateTimeOriginal": sub.get(0x9003)}


def scan(label, s, problems):
    for w in BANNED:
        if w in s:
            problems.append("{}: 書いてはいけない言葉「{}」".format(label, w))
    for w in MOJIBAKE:
        if w in s:
            problems.append("{}: 字化けの疑い「{}」".format(label, w))
    for w in REAL_NAMES:
        if w in s:
            problems.append("{}: 実在の名前の候補「{}」".format(label, w))


def main():
    problems = []
    texts = {}
    rows = []
    for folder in (DIR_REL, DIR_UNREL):
        for name in sorted(os.listdir(folder)):
            path = os.path.join(folder, name)
            size = os.path.getsize(path)
            ext = os.path.splitext(name)[1].lower()
            info = ""
            text = ""
            if ext == ".docx":
                text, meta = docx_text(path)
                info = "core created {} modified {}".format(meta["created"], meta["modified"])
            elif ext == ".xlsx":
                text, meta = xlsx_text(path)
                info = "created {} modified {} creator {}".format(meta["created"], meta["modified"], meta["creator"])
            elif ext == ".pdf":
                text, meta = pdf_text(path)
                info = "{} pages, fonts {}".format(meta["pages"], ", ".join(meta["fonts"]))
            elif ext == ".jpg":
                meta = jpg_info(path)
                info = "{}x{} {} DateTimeOriginal {}".format(meta["size"][0], meta["size"][1], meta["mode"], meta["DateTimeOriginal"])
            elif ext == ".txt":
                raw = open(path, "rb").read()
                if raw.startswith(b"\xef\xbb\xbf"):
                    problems.append(name + ": BOM がある")
                if b"\r" in raw:
                    problems.append(name + ": CRLF がある")
                text = raw.decode("utf-8")
                info = "{} lines".format(len(text.splitlines()))
            scan(name, name + "\n" + text, problems)
            texts[name] = text
            rows.append((os.path.basename(folder), name, size, info))
    md = os.path.join(BASE, "送り方.md")
    raw = open(md, "rb").read()
    if raw.startswith(b"\xef\xbb\xbf") or b"\r" in raw:
        problems.append("送り方.md: BOM か CRLF がある")
    mdt = raw.decode("utf-8")
    for w in MOJIBAKE + REAL_NAMES:
        if w in mdt:
            problems.append("送り方.md: 候補「{}」".format(w))
    for w in BANNED:
        if w in mdt:
            problems.append("送り方.md: 書いてはいけない言葉「{}」".format(w))
    rows.append(("", "送り方.md", len(raw), "{} lines".format(len(mdt.splitlines()))))

    for folder, name, size, info in rows:
        print("{:<16} {:<44} {:>9,}  {}".format(folder, name, size, info))

    # 「〇〇市」の形の言葉を拾って目で見る
    cities = set()
    for name, t in texts.items():
        for m in re.finditer(r"[一-龥ぁ-んァ-ヶ]{1,4}[市町村区]", t):
            cities.add(m.group(0))
    print("\n市町村区で終わる言葉:", "、".join(sorted(cities)))

    # 三組の違い
    print("\n組 1（案内）の違い:")
    a = texts["2025年度_秋の収穫祭のご案内.docx"].splitlines()
    b = texts["2025年度_秋の収穫祭のご案内(1).docx"].splitlines()
    for ln in difflib.unified_diff(a, b, "無印", "(1)", lineterm="", n=0):
        print("  " + ln)
    print("\n組 2（当番表）の違い:")
    a = texts["2025年度_秋の収穫祭の当番表.xlsx"].splitlines()
    b = texts["2025年度_秋の収穫祭の当番表 - コピー.xlsx"].splitlines()
    for ln in difflib.unified_diff(a, b, "元", "コピー", lineterm="", n=0):
        print("  " + ln)

    print("\n確かめの結果:", "問題なし" if not problems else "")
    for pr in problems:
        print("  " + pr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
