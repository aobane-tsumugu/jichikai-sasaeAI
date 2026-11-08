# -*- coding: utf-8 -*-
"""デモ資料を作るための共通の道具。

- 紙をスマホで撮った形の JPEG にする photo()
- 手書きらしく一字ずつずらして書く handwrite() と、手で引いた線
- 最小の OOXML で .docx を書く write_docx()
- PyMuPDF で日本語の PDF を書くための折り返し wrap_ja()

実行は Python 3.13（openpyxl、PIL、PyMuPDF、numpy）。新しいパッケージは使わない。
"""
import datetime
import math
import os
import random
import zipfile
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR_REL = os.path.join(BASE, "01_関係する資料")
DIR_UNREL = os.path.join(BASE, "02_関係ない資料")

FONTS = r"C:\Windows\Fonts"
F_GOTH_M = os.path.join(FONTS, "YuGothM.ttc")
F_GOTH_B = os.path.join(FONTS, "YuGothB.ttc")
F_MIN = os.path.join(FONTS, "BIZ-UDMinchoM.ttc")
F_UDG = os.path.join(FONTS, "BIZ-UDGothicR.ttc")

JST = datetime.timezone(datetime.timedelta(hours=9))

_font_cache = {}


def font(path, size):
    size = max(6, int(round(size)))
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size, index=0)
    return _font_cache[key]


def set_mtime(path, dt):
    """ファイルの更新日時を、中身の日付と揃える（dt は JST の datetime）。"""
    ts = dt.replace(tzinfo=JST).timestamp()
    os.utime(path, (ts, ts))


# ---------------------------------------------------------------------------
# 紙の上に書く
# ---------------------------------------------------------------------------

def new_paper(w, h, color=(251, 250, 246)):
    return Image.new("RGB", (w, h), color)


def text(draw, xy, s, size, path=F_GOTH_M, fill=(20, 20, 20), anchor="la", **kw):
    draw.text(xy, s, font=font(path, size), fill=fill, anchor=anchor, **kw)


def text_width(s, size, path=F_GOTH_M):
    return font(path, size).getlength(s)


def handwrite(img, x, y, s, size, rng, path=F_GOTH_M, color=(28, 34, 70),
              jit_size=0.10, jit_pos=None, jit_rot=5.0, spacing=1.0,
              slope=0.0, stroke=0, opacity=0.92):
    """一字ずつ大きさ、位置、傾きをずらして書く。終わりの x を返す。

    y は字の上端の目安。rng は random.Random。
    """
    if jit_pos is None:
        jit_pos = size * 0.05
    drift = 0.0
    for ch in s:
        if ch in (" ", "\u3000"):
            x += size * (0.35 if ch == " " else 0.9) * spacing
            continue
        sz = size * (1.0 + rng.uniform(-jit_size, jit_size))
        f = font(path, sz)
        pad = int(sz * 0.5)
        tw = int(f.getlength(ch)) + pad * 2
        th = int(sz * 1.5) + pad * 2
        tile = Image.new("L", (tw, th), 0)
        d = ImageDraw.Draw(tile)
        d.text((pad, pad), ch, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
        tile = tile.rotate(rng.uniform(-jit_rot, jit_rot), resample=Image.BICUBIC)
        if opacity < 1:
            tile = tile.point(lambda v: int(v * opacity))
        c = tuple(max(0, min(255, int(v + rng.uniform(-8, 8)))) for v in color)
        ink = Image.new("RGB", tile.size, c)
        px = x + rng.gauss(0, jit_pos)
        py = y + rng.gauss(0, jit_pos) + drift + (size - sz) * 0.5
        img.paste(ink, (int(px - pad), int(py - pad)), tile)
        x += f.getlength(ch) * spacing + rng.uniform(-0.04, 0.10) * size
        drift += rng.gauss(0, size * 0.015) + slope * size
    return x


def wobble_points(p0, p1, rng, amp=1.6, step=18):
    x0, y0 = p0
    x1, y1 = p1
    length = math.hypot(x1 - x0, y1 - y0)
    n = max(2, int(length / step))
    nx, ny = -(y1 - y0) / (length or 1), (x1 - x0) / (length or 1)
    pts = []
    off = 0.0
    for i in range(n + 1):
        t = i / n
        off = off * 0.7 + rng.gauss(0, amp)
        if i in (0, n):
            o = off * 0.4
        else:
            o = off
        pts.append((x0 + (x1 - x0) * t + nx * o, y0 + (y1 - y0) * t + ny * o))
    return pts


def hand_line(draw, p0, p1, rng, width=4, fill=(30, 34, 60), amp=1.6):
    pts = wobble_points(p0, p1, rng, amp=amp)
    draw.line(pts, fill=fill, width=width, joint="curve")


def hand_rect(draw, box, rng, width=4, fill=(30, 34, 60), amp=1.8):
    x0, y0, x1, y1 = box
    ov = lambda: rng.uniform(-6, 10)
    hand_line(draw, (x0 - ov(), y0 + rng.uniform(-3, 3)), (x1 + ov(), y0 + rng.uniform(-3, 3)), rng, width, fill, amp)
    hand_line(draw, (x1 + rng.uniform(-3, 3), y0 - ov()), (x1 + rng.uniform(-3, 3), y1 + ov()), rng, width, fill, amp)
    hand_line(draw, (x1 + ov(), y1 + rng.uniform(-3, 3)), (x0 - ov(), y1 + rng.uniform(-3, 3)), rng, width, fill, amp)
    hand_line(draw, (x0 + rng.uniform(-3, 3), y1 + ov()), (x0 + rng.uniform(-3, 3), y0 - ov()), rng, width, fill, amp)


def hand_ellipse(draw, box, rng, width=4, fill=(30, 34, 60), turns=1.12):
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
    start = rng.uniform(0, 2 * math.pi)
    n = 80
    pts = []
    wob = 0.0
    for i in range(n + 1):
        t = start + 2 * math.pi * turns * i / n
        wob = wob * 0.8 + rng.gauss(0, 0.02)
        k = 1.0 + wob + 0.05 * i / n
        pts.append((cx + rx * k * math.cos(t), cy + ry * k * math.sin(t)))
    draw.line(pts, fill=fill, width=width, joint="curve")


def hand_check(draw, x, y, s, rng, width=5, fill=(30, 34, 60)):
    p0 = (x, y + s * 0.5)
    p1 = (x + s * 0.35 + rng.uniform(-2, 2), y + s * 0.9)
    p2 = (x + s * 1.0 + rng.uniform(-3, 3), y + rng.uniform(-3, 3))
    draw.line(wobble_points(p0, p1, rng, amp=0.8, step=8) + wobble_points(p1, p2, rng, amp=1.0, step=10)[1:],
              fill=fill, width=width, joint="curve")


def hand_arrow(draw, p0, p1, rng, width=4, fill=(30, 34, 60), head=22):
    hand_line(draw, p0, p1, rng, width, fill)
    ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    for da in (2.6, -2.6):
        q = (p1[0] + head * math.cos(ang + da), p1[1] + head * math.sin(ang + da))
        hand_line(draw, p1, q, rng, width, fill, amp=0.6)


def crease(img, pos, horizontal=True, strength=14):
    """紙を折った跡（明るい筋と暗い筋）を入れる。"""
    arr = np.asarray(img, np.float32).copy()
    n = arr.shape[0] if horizontal else arr.shape[1]
    idx = np.arange(n, dtype=np.float32)
    prof = np.exp(-((idx - pos + 3) / 3.0) ** 2) * strength - np.exp(-((idx - pos - 3) / 4.0) ** 2) * strength * 0.8
    prof += -np.exp(-((idx - pos) / 60.0) ** 2) * 4
    if horizontal:
        arr += prof[:, None, None]
    else:
        arr += prof[None, :, None]
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def ruled_paper(w, h, rng, line_gap=80, top=220, margin_left=150,
                color=(250, 249, 243), line_color=(160, 185, 215)):
    """大学ノートの罫線の紙。"""
    img = new_paper(w, h, color)
    d = ImageDraw.Draw(img)
    y = top
    while y < h - 60:
        d.line([(0, y), (w, y)], fill=line_color, width=2)
        y += line_gap
    d.line([(margin_left, 0), (margin_left, h)], fill=(225, 160, 160), width=2)
    return img


# ---------------------------------------------------------------------------
# スマホで撮った形にする
# ---------------------------------------------------------------------------

def _perspective_coeffs(src_pts, dst_pts):
    """出力の点 -> 入力の点の係数（PIL の PERSPECTIVE 用）。"""
    a = []
    b = []
    for (x, y), (u, v) in zip(dst_pts, src_pts):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def _lowfreq(w, h, rng_np, cell=64):
    small = rng_np.normal(0, 1, (max(2, h // cell), max(2, w // cell))).astype(np.float32)
    im = Image.fromarray(((small - small.min()) / (np.ptp(small) + 1e-6) * 255).astype(np.uint8))
    im = im.resize((w, h), Image.BICUBIC)
    return np.asarray(im, np.float32) / 255.0 - 0.5


DESKS = {
    "wood": (152, 108, 72),
    "darkwood": (98, 68, 46),
    "gray": (128, 128, 126),
    "beige": (196, 178, 150),
    "green": (72, 104, 86),
}


def desk_texture(w, h, kind, rng_np):
    base = np.array(DESKS[kind], np.float32)
    lf = _lowfreq(w, h, rng_np, cell=160)
    arr = np.ones((h, w, 3), np.float32) * base
    if kind in ("wood", "darkwood"):
        # 木目: 行ごとの揺らぎを横に長く伸ばす
        rows = rng_np.normal(0, 1, h // 3 + 2).astype(np.float32)
        rows = np.convolve(rows, np.ones(5) / 5, mode="same")
        rows = np.repeat(rows, 3)[:h]
        bend = _lowfreq(w, h, rng_np, cell=300) * 40
        yy = (np.arange(h)[:, None] + bend).astype(int).clip(0, h - 1)
        grain = rows[yy]
        stripes = np.sin((np.arange(h)[:, None] + bend * 3) / rng_np.uniform(9, 15)) * 0.5
        g = (grain * 0.06 + stripes * 0.035)[:, :, None]
        arr = arr * (1 + g)
    arr = arr * (1 + lf[:, :, None] * 0.10)
    fine = rng_np.normal(0, 3.0, (h, w, 1)).astype(np.float32)
    arr = arr + fine
    return arr.clip(0, 255)


def photo(paper, out_path, seed, desk="wood", size=(1500, 2000), fill=0.86,
          angle=None, keystone=None, offset=None, light=None, warm=None,
          quality=85, exif_datetime=None, hand_shadow=False, curl=0.0):
    """紙の画像 paper（RGB）を机に置いてスマホで撮った形の JPEG にする。"""
    rng = random.Random(seed)
    rng_np = np.random.default_rng(seed)
    W, H = size
    pw, ph = paper.size

    # 紙を最終に近い大きさに縮める（縮小の折り返しを避ける）
    scale = min(W * fill / pw, H * fill / ph)
    sw, sh = int(pw * scale), int(ph * scale)
    small = paper.resize((sw, sh), Image.LANCZOS)

    # 紙のむら（白の差を少し）
    pa = np.asarray(small, np.float32)
    pa = pa * (1 + _lowfreq(sw, sh, rng_np, cell=200)[:, :, None] * 0.025)
    small = Image.fromarray(pa.clip(0, 255).astype(np.uint8))

    if angle is None:
        angle = rng.uniform(-3.0, 3.0)
    if keystone is None:
        keystone = rng.uniform(0.015, 0.045)
    if offset is None:
        offset = (rng.uniform(-30, 30), rng.uniform(-30, 30))
    cx, cy = W / 2 + offset[0], H / 2 + offset[1]
    hw, hh = sw / 2, sh / 2
    k = keystone * sw / 2
    corners = [(-hw + k, -hh), (hw - k, -hh), (hw, hh), (-hw, hh)]
    a = math.radians(angle)
    dst = []
    for (x, y) in corners:
        xr = x * math.cos(a) - y * math.sin(a)
        yr = x * math.sin(a) + y * math.cos(a)
        dst.append((cx + xr + rng.uniform(-5, 5), cy + yr + rng.uniform(-5, 5)))
    src = [(0, 0), (sw, 0), (sw, sh), (0, sh)]
    coeffs = _perspective_coeffs(src, dst)

    warped = small.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(0, 0, 0))
    mask = Image.new("L", (sw, sh), 255).transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=0)
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))

    desk_arr = desk_texture(W, H, desk, rng_np)

    # 端の影
    sh_mask = mask.filter(ImageFilter.GaussianBlur(14))
    sh_img = Image.new("L", (W, H), 0)
    sh_img.paste(sh_mask, (int(rng.uniform(6, 14)), int(rng.uniform(10, 18))))
    shadow = np.asarray(sh_img, np.float32) / 255.0
    desk_arr = desk_arr * (1 - shadow[:, :, None] * 0.42)

    m = np.asarray(mask, np.float32)[:, :, None] / 255.0
    paper_arr = np.asarray(warped, np.float32)
    if curl:
        # 紙の端のわずかな反り（片側が少し暗い）
        xs = np.linspace(-1, 1, W)[None, :, None]
        paper_arr = paper_arr * (1 - curl * np.clip(xs, 0, 1) ** 3)
    out = desk_arr * (1 - m) + paper_arr * m

    # 明るさのむら（光の中心から離れるほど暗く）
    if light is None:
        light = (rng.uniform(0.2, 0.8) * W, rng.uniform(0.0, 0.45) * H)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    dist = np.hypot(xx - light[0], yy - light[1]) / math.hypot(W, H)
    lum = 1.06 - 0.30 * dist ** 1.3
    out = out * lum[:, :, None]

    if hand_shadow:
        # スマホと手の影がやわらかく端に入る
        hs = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(hs)
        ex = rng.choice([-0.25, 1.05]) * W
        d.ellipse([ex - W * 0.35, H * 0.55, ex + W * 0.45, H * 1.2], fill=255)
        hs = hs.filter(ImageFilter.GaussianBlur(120))
        out = out * (1 - np.asarray(hs, np.float32)[:, :, None] / 255.0 * 0.22)

    if warm is None:
        warm = rng.uniform(-0.6, 1.0)
    tint = np.array([1 + 0.035 * warm, 1.0, 1 - 0.06 * warm], np.float32)
    out = out * tint

    img = Image.fromarray(out.clip(0, 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(0.65))
    arr = np.asarray(img, np.float32)
    arr = arr + rng_np.normal(0, 2.2, (H, W, 1)).astype(np.float32) + rng_np.normal(0, 1.0, (H, W, 3)).astype(np.float32)
    img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

    kw = {"quality": quality, "optimize": True}
    if exif_datetime:
        exif = Image.Exif()
        exif[0x0132] = exif_datetime  # DateTime
        ifd = exif.get_ifd(0x8769)
        ifd[0x9003] = exif_datetime  # DateTimeOriginal
        ifd[0x9004] = exif_datetime  # DateTimeDigitized
        kw["exif"] = exif
    img.save(out_path, "JPEG", **kw)
    return out_path


# ---------------------------------------------------------------------------
# docx（最小の OOXML）
# ---------------------------------------------------------------------------

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def run(s, bold=False, size=None, font_name=None, underline=False):
    rpr = []
    if font_name:
        rpr.append('<w:rFonts w:ascii="{0}" w:hAnsi="{0}" w:eastAsia="{0}"/>'.format(escape(font_name)))
    if bold:
        rpr.append("<w:b/>")
    if size:
        rpr.append('<w:sz w:val="{0}"/><w:szCs w:val="{0}"/>'.format(int(size * 2)))
    if underline:
        rpr.append('<w:u w:val="single"/>')  # スキーマの順で sz の後
    rpr_xml = "<w:rPr>{}</w:rPr>".format("".join(rpr)) if rpr else ""
    parts = s.split("\t")
    out = []
    for i, part in enumerate(parts):
        if i > 0:
            out.append("<w:r>{}<w:tab/></w:r>".format(rpr_xml))
        if part:
            out.append('<w:r>{}<w:t xml:space="preserve">{}</w:t></w:r>'.format(rpr_xml, escape(part)))
    return "".join(out)


def para(content="", align=None, bold=False, size=None, font_name=None,
         indent=None, hanging=None, before=None, after=None, runs=None):
    ppr = []
    sp = []
    if before is not None:
        sp.append('w:before="{}"'.format(int(before)))
    if after is not None:
        sp.append('w:after="{}"'.format(int(after)))
    if sp:
        ppr.append("<w:spacing {}/>".format(" ".join(sp)))
    if indent is not None or hanging is not None:
        attrs = []
        if indent is not None:
            attrs.append('w:left="{}"'.format(int(indent)))
        if hanging is not None:
            attrs.append('w:hanging="{}"'.format(int(hanging)))
        ppr.append("<w:ind {}/>".format(" ".join(attrs)))
    if align:
        ppr.append('<w:jc w:val="{}"/>'.format(align))
    ppr_xml = "<w:pPr>{}</w:pPr>".format("".join(ppr)) if ppr else ""
    if runs is None:
        body = run(content, bold=bold, size=size, font_name=font_name) if content else ""
    else:
        body = "".join(runs)
    return "<w:p>{}{}</w:p>".format(ppr_xml, body)


def table(rows, widths, bold_first_col=True, size=None):
    """rows は文字列の二次元の並び。widths は twip。"""
    grid = "".join('<w:gridCol w:w="{}"/>'.format(w) for w in widths)
    border = ('<w:tblBorders>'
              '<w:top w:val="single" w:sz="6" w:space="0" w:color="555555"/>'
              '<w:left w:val="single" w:sz="6" w:space="0" w:color="555555"/>'
              '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="555555"/>'
              '<w:right w:val="single" w:sz="6" w:space="0" w:color="555555"/>'
              '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="888888"/>'
              '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="888888"/>'
              '</w:tblBorders>')
    trs = []
    for r in rows:
        tcs = []
        for i, cell in enumerate(r):
            lines = cell.split("\n")
            ps = "".join(para(ln, bold=(bold_first_col and i == 0), size=size, before=40, after=40) for ln in lines)
            tcs.append('<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/></w:tcPr>{}</w:tc>'.format(widths[i], ps))
        trs.append("<w:tr>{}</w:tr>".format("".join(tcs)))
    return ('<w:tbl><w:tblPr><w:tblW w:w="{}" w:type="dxa"/>{}'
            '<w:tblCellMar><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>'
            '</w:tblPr><w:tblGrid>{}</w:tblGrid>{}</w:tbl>').format(sum(widths), border, grid, "".join(trs))


def _iso(dt):
    """JST の datetime を UTC の W3CDTF にする。"""
    return dt.replace(tzinfo=JST).astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_docx(path, body_xml, title, creator, created, modified,
               font_name="游明朝", size=10.5):
    """created と modified は JST の datetime。docProps/core.xml に入れる。"""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '</Types>')
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '</Relationships>')
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>')
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:styles xmlns:w="{ns}">'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="{f}" w:hAnsi="{f}" w:eastAsia="{f}" w:cs="{f}"/>'
        '<w:kern w:val="2"/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/><w:lang w:val="en-US" w:eastAsia="ja-JP"/>'
        '</w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
        '</w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>'
        '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>'
        '<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>'
        '</w:tblCellMar></w:tblPr></w:style>'
        '</w:styles>').format(ns=W_NS, f=escape(font_name), sz=int(size * 2))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="{ns}"><w:body>{body}'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1701" w:right="1418" w:bottom="1418" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/>'
        '</w:sectPr></w:body></w:document>').format(ns=W_NS, body=body_xml)
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:title>{t}</dc:title><dc:creator>{c}</dc:creator><cp:lastModifiedBy>{c}</cp:lastModifiedBy>'
        '<cp:revision>1</cp:revision>'
        '<dcterms:created xsi:type="dcterms:W3CDTF">{cr}</dcterms:created>'
        '<dcterms:modified xsi:type="dcterms:W3CDTF">{mo}</dcterms:modified>'
        '</cp:coreProperties>').format(t=escape(title), c=escape(creator), cr=_iso(created), mo=_iso(modified))

    zdt = modified.timetuple()[:6]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in [("[Content_Types].xml", content_types), ("_rels/.rels", rels),
                           ("docProps/core.xml", core), ("word/document.xml", document),
                           ("word/_rels/document.xml.rels", doc_rels), ("word/styles.xml", styles)]:
            zi = zipfile.ZipInfo(name, date_time=zdt)
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data.encode("utf-8"))
    set_mtime(path, modified)


def retime_zip(path, dt):
    """xlsx の更新日時を dt（JST）に揃える。

    openpyxl は保存の時に properties.modified を今の時刻で上書きするので、
    docProps/core.xml の dcterms:modified と、zip の中の各項目の日時を書き直す。
    """
    import re
    with zipfile.ZipFile(path) as z:
        items = [(i.filename, z.read(i.filename)) for i in z.infolist()]
    fixed = []
    for name, data in items:
        if name == "docProps/core.xml":
            s = data.decode("utf-8")
            s, n = re.subn(r"(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)",
                           lambda m: m.group(1) + _iso(dt) + m.group(2), s)
            if n != 1:
                raise RuntimeError("dcterms:modified が見つからない: " + path)
            data = s.encode("utf-8")
        fixed.append((name, data))
    items = fixed
    zdt = dt.timetuple()[:6]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in items:
            zi = zipfile.ZipInfo(name, date_time=zdt)
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
    set_mtime(path, dt)


def utc_naive(dt_jst):
    """openpyxl の properties は UTC の naive datetime を期待する。"""
    return dt_jst.replace(tzinfo=JST).astimezone(datetime.timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# PDF（PyMuPDF）
# ---------------------------------------------------------------------------

NO_LINE_START = set("、。，．）」』】〕・ー々ゃゅょっぁぃぅぇぉャュョッァィゥェォ！？：；")
NO_LINE_END = set("（「『【〔")


def wrap_ja(s, fitz_font, fontsize, width, first_width=None):
    """日本語を幅で折り返す。行頭の句読点と行末の開き括弧を避ける。

    first_width は各段落の一行目の幅（ぶら下げの字下げに使う）。
    """
    lines = []
    for raw in s.split("\n"):
        cur = ""
        for ch in raw:
            trial = cur + ch
            wlim = first_width if (first_width and len(lines) == 0) else width
            if fitz_font.text_length(trial, fontsize=fontsize) <= wlim or not cur:
                cur = trial
                continue
            if ch in NO_LINE_START:
                # ぶら下げ: 句読点は前の行に入れる
                cur = trial
                continue
            if cur and cur[-1] in NO_LINE_END:
                lines.append(cur[:-1])
                cur = cur[-1] + ch
                continue
            lines.append(cur)
            cur = ch
        lines.append(cur)
    return lines


def pdf_date(dt):
    return dt.strftime("D:%Y%m%d%H%M%S+09'00'")


def write_text(path, s):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)
