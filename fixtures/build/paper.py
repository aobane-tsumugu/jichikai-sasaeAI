"""紙の写真風と手書き風の画像を作る部品。

全て合成で、実際の撮影でも実際の手書きでもない。印字はプログラムで組み、手書きは
教科書体の文字を一字ずつ傾けてずらして書き足し、線や丸は揺らして引く。紙の上に
置いた形に歪め、影と明るさのむらと粒を足して、スマホで撮った写真のように見せる。
"""
from __future__ import annotations

import math
import os
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

# Windows に入っている字体。画像に焼いて使うだけで、字体のファイルは置かない。
# 他の環境で作り直す時は FIXTURE_FONT_DIR に同じ名前のファイルがある場所を指す。
FONT_DIR = Path(os.environ.get("FIXTURE_FONT_DIR", "C:/Windows/Fonts"))
PRINT = "BIZ-UDGothicR.ttc"
PRINT_BOLD = "BIZ-UDGothicB.ttc"
MINCHO = "BIZ-UDMinchoM.ttc"
HAND = "UDDigiKyokashoN-R.ttc"
HAND_BOLD = "UDDigiKyokashoN-B.ttc"

BLACK_INK = (26, 28, 36)
BLUE_INK = (22, 44, 126)
RED_INK = (170, 36, 40)
PENCIL = (78, 80, 86)

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
_cmap_cache: dict[str, set[int]] = {}


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    key = (name, size)
    if key not in _font_cache:
        path = FONT_DIR / name
        if not path.exists():
            raise FileNotFoundError(f"字体が見つかりません: {path}（FIXTURE_FONT_DIR で場所を指定）")
        _font_cache[key] = ImageFont.truetype(str(path), size)
    return _font_cache[key]


def require_glyphs(name: str, s: str) -> None:
    """字体に無い文字が豆腐（四角）になるのを防ぐ。無ければここで止める。"""
    if name not in _cmap_cache:
        from fontTools.ttLib import TTCollection

        _cmap_cache[name] = set(TTCollection(str(FONT_DIR / name)).fonts[0].getBestCmap())
    missing = sorted({c for c in s if c not in "\n 　" and ord(c) not in _cmap_cache[name]})
    if missing:
        raise ValueError(f"{name} に無い文字: {''.join(missing)}（文: {s}）")


def text_width(s: str, size: int, name: str = PRINT) -> float:
    return font(name, size).getlength(s)


class Sheet:
    """一枚の紙。印字と手書きを重ねる。"""

    def __init__(self, w: int, h: int, rng: random.Random, paper=(249, 247, 240)):
        self.w, self.h = w, h
        self.rng = rng
        self.img = Image.new("RGB", (w, h), paper)
        self.d = ImageDraw.Draw(self.img)

    # ---- 印字 ----
    def print(self, xy, s, size=28, bold=False, fill=(34, 34, 38), mincho=False):
        name = MINCHO if mincho else (PRINT_BOLD if bold else PRINT)
        require_glyphs(name, s)
        self.d.text(xy, s, font=font(name, size), fill=fill)
        return xy[0] + text_width(s, size, name)

    def print_wrapped(self, xy, s, size, max_w, line_gap=1.5, **kw):
        x, y = xy
        name = MINCHO if kw.get("mincho") else (PRINT_BOLD if kw.get("bold") else PRINT)
        line = ""
        for ch in s:
            if text_width(line + ch, size, name) > max_w:
                self.print((x, y), line, size, **kw)
                y += int(size * line_gap)
                line = ch
            else:
                line += ch
        if line:
            self.print((x, y), line, size, **kw)
            y += int(size * line_gap)
        return y

    def rect(self, box, width=2, fill=None, outline=(60, 60, 64)):
        self.d.rectangle(box, outline=outline, width=width, fill=fill)

    def line(self, p0, p1, width=2, fill=(60, 60, 64)):
        self.d.line([p0, p1], fill=fill, width=width)

    def lined_paper(self, top=140, gap=58, color=(176, 196, 218), margin=(90, 40)):
        for y in range(top, self.h - 40, gap):
            self.d.line([(margin[1], y), (self.w - margin[1], y)], fill=color, width=2)
        self.d.line([(margin[0], 0), (margin[0], self.h)], fill=(226, 164, 164), width=2)

    # ---- 手書き ----
    def _stamp(self, mask: Image.Image, ink, alpha=1.0, origin=(0, 0)):
        if alpha < 1.0:
            mask = mask.point(lambda v: int(v * alpha))
        self.img.paste(Image.new("RGB", mask.size, ink), origin, mask)

    def hand(self, xy, s, size=38, ink=BLUE_INK, bold=False, tilt=0.0, max_w=None):
        """一字ずつ大きさと傾きとずれを変えて書く。最後の字の右端を返す。"""
        rng = self.rng
        name = HAND_BOLD if bold else HAND
        require_glyphs(name, s)
        x, y = xy
        drift = 0.0
        start_x = x
        for ch in s:
            if ch == "\n":
                x, y = start_x, y + int(size * 1.35)
                continue
            if ch in " 　":
                x += size * 0.45
                continue
            sz = max(10, int(size * rng.uniform(0.93, 1.07)))
            f = font(name, sz)
            pad = int(sz * 0.6)
            layer = Image.new("L", (sz + pad * 2, sz + pad * 2), 0)
            ImageDraw.Draw(layer).text((pad, pad // 2), ch, font=f, fill=255)
            angle = rng.gauss(0, 2.4) + tilt
            layer = layer.rotate(angle, resample=Image.Resampling.BICUBIC)
            drift = drift * 0.8 + rng.gauss(0, size * 0.018)
            self._stamp(layer, ink, alpha=rng.uniform(0.82, 0.98),
                        origin=(int(x - pad * 0.5), int(y + drift - pad * 0.4)))
            adv = f.getlength(ch) * rng.uniform(0.9, 1.03)
            x += adv
            if max_w and x - start_x > max_w:
                x, y = start_x, y + int(size * 1.35)
        return x

    def _poly_mask(self, pts, width, closed=False):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        pad = int(width * 3 + 8)
        x0, y0 = int(min(xs)) - pad, int(min(ys)) - pad
        x1, y1 = int(max(xs)) + pad, int(max(ys)) + pad
        sc = 2
        m = Image.new("L", ((x1 - x0) * sc, (y1 - y0) * sc), 0)
        dm = ImageDraw.Draw(m)
        sp = [((x - x0) * sc, (y - y0) * sc) for x, y in pts]
        dm.line(sp + ([sp[0]] if closed else []), fill=255, width=max(1, int(width * sc)), joint="curve")
        m = m.resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
        return m, (x0, y0)

    def _wobble(self, p0, p1, amp=1.6, step=16):
        rng = self.rng
        n = max(2, int(math.dist(p0, p1) / step))
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln, dx / ln
        pts = []
        off = 0.0
        for i in range(n + 1):
            t = i / n
            off = off * 0.6 + rng.gauss(0, amp)
            pts.append((p0[0] + dx * t + nx * off, p0[1] + dy * t + ny * off))
        return pts

    def hand_line(self, p0, p1, width=3.2, ink=BLUE_INK, amp=1.4):
        pts = self._wobble(p0, p1, amp)
        m, o = self._poly_mask(pts, width)
        self._stamp(m, ink, self.rng.uniform(0.85, 0.98), o)

    def hand_rect(self, box, width=3.2, ink=BLUE_INK, amp=0.9):
        x0, y0, x1, y1 = box
        r = self.rng
        j = lambda: r.uniform(-4, 4)
        corners = [(x0 + j(), y0 + j()), (x1 + j(), y0 + j()), (x1 + j(), y1 + j()), (x0 + j(), y1 + j())]
        for a, b in zip(corners, corners[1:] + corners[:1]):
            self.hand_line(a, b, width, ink, amp)

    def hand_circle(self, cx, cy, rx, ry, width=3.4, ink=BLUE_INK):
        """少し重なる、手で描いた丸。"""
        r = self.rng
        t0 = r.uniform(0, 2 * math.pi)
        rot = r.uniform(-0.25, 0.25)
        pts = []
        steps = 44
        wob = 0.0
        for i in range(steps + 6):
            t = t0 + (i / steps) * 2 * math.pi * 1.04
            wob = wob * 0.7 + r.gauss(0, 0.02)
            ex = rx * (1 + wob) * math.cos(t)
            ey = ry * (1 + wob - 0.012 * i / steps) * math.sin(t)
            pts.append((cx + ex * math.cos(rot) - ey * math.sin(rot),
                        cy + ex * math.sin(rot) + ey * math.cos(rot)))
        m, o = self._poly_mask(pts, width)
        self._stamp(m, ink, r.uniform(0.85, 0.98), o)

    def hand_check(self, x, y, size=34, width=4.0, ink=BLUE_INK):
        r = self.rng
        pts = [(x + r.uniform(-2, 2), y + size * 0.5), (x + size * 0.32, y + size * 0.95),
               (x + size * 1.0, y - size * 0.15)]
        m, o = self._poly_mask(pts, width)
        self._stamp(m, ink, r.uniform(0.88, 0.98), o)

    def hand_cross(self, x, y, size=34, width=3.6, ink=BLUE_INK):
        self.hand_line((x, y), (x + size, y + size), width, ink)
        self.hand_line((x + size, y), (x, y + size), width, ink)

    def hand_underline(self, x0, x1, y, width=2.6, ink=BLUE_INK):
        self.hand_line((x0, y), (x1, y + self.rng.uniform(-3, 3)), width, ink, amp=1.0)

    def hand_arrow(self, p0, p1, width=3.0, ink=BLUE_INK):
        self.hand_line(p0, p1, width, ink)
        ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
        for da in (2.6, -2.6):
            q = (p1[0] + 22 * math.cos(ang + da), p1[1] + 22 * math.sin(ang + da))
            self.hand_line(p1, q, width, ink, amp=0.6)

    def seal(self, cx, cy, r, label, ink=RED_INK):
        """赤い角印か丸印。"""
        rng = self.rng
        layer = Image.new("L", (r * 2 + 20, r * 2 + 20), 0)
        d = ImageDraw.Draw(layer)
        d.ellipse((8, 8, r * 2 + 12, r * 2 + 12), outline=255, width=5)
        f = font(PRINT_BOLD, int(r * 0.62))
        lines = label.split("\n")
        total = len(lines) * int(r * 0.7)
        yy = r + 10 - total // 2
        for ln in lines:
            w = f.getlength(ln)
            d.text((r + 10 - w / 2, yy), ln, font=f, fill=255)
            yy += int(r * 0.7)
        layer = layer.rotate(rng.uniform(-8, 8), resample=Image.Resampling.BICUBIC)
        self._stamp(layer, ink, 0.78, (int(cx - r - 10), int(cy - r - 10)))


# ---- 写真風にする ----

def _coeffs(dst, src):
    """出力の四隅 dst から入力の四隅 src への透視変換の係数（PIL の形）。"""
    a = []
    b = []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.extend([u, v])
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def desk(w: int, h: int, seed: int, kind: str = "wood") -> Image.Image:
    rng = np.random.default_rng(seed)

    def blur_noise(sh):
        n = rng.normal(0, 1, sh).astype("float32")
        im = Image.fromarray(n, "F").resize((w, h), Image.Resampling.BICUBIC)
        return np.asarray(im)

    if kind == "wood":
        base = np.array([156, 128, 98], float)
        low = blur_noise((h // 90 + 2, w // 90 + 2))
        streak = blur_noise((h // 3 + 2, w // 70 + 2))
        v = base[None, None, :] + 11 * low[..., None] + 8 * streak[..., None] * np.array([1.0, 0.9, 0.8])
    elif kind == "white":
        base = np.array([214, 212, 206], float)
        low = blur_noise((h // 120 + 2, w // 120 + 2))
        v = base[None, None, :] + 6 * low[..., None]
    else:  # dark
        base = np.array([88, 84, 80], float)
        low = blur_noise((h // 100 + 2, w // 100 + 2))
        v = base[None, None, :] + 8 * low[..., None]
    v += rng.normal(0, 2.2, (h, w, 1))
    return Image.fromarray(np.clip(v, 0, 255).astype("uint8"), "RGB")


def _paper_tone(sheet: Image.Image, seed: int, crease: int = 0) -> Image.Image:
    """紙の粒と、折り目と、端のうねり。"""
    rng = np.random.default_rng(seed)
    a = np.asarray(sheet).astype("float32")
    h, w = a.shape[:2]
    low = np.asarray(Image.fromarray(rng.normal(0, 1, (h // 160 + 2, w // 160 + 2)).astype("float32"), "F")
                     .resize((w, h), Image.Resampling.BICUBIC))
    a *= (1 + 0.012 * low)[..., None]
    a += rng.normal(0, 1.8, (h, w, 1))
    yy, xx = np.mgrid[0:h, 0:w]
    bend = 1 - 0.05 * (((xx / w) - 0.5) ** 2) * 4 - 0.025 * (yy / h)
    a *= bend[..., None]
    for i in range(1, crease + 1):
        cy = int(h * i / (crease + 1))
        band = np.exp(-(((yy - cy) / 3.0) ** 2))
        band2 = np.exp(-(((yy - cy - 5) / 5.0) ** 2))
        a *= (1 - 0.07 * band + 0.025 * band2)[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype("uint8"), "RGB")


def place(canvas: Image.Image, sheet: Sheet | Image.Image, center, scale=1.0, angle=0.0,
          jitter=14.0, seed=0, crease=0, shadow=1.0) -> None:
    """紙を机の上に、少し斜めと台形に歪めて置く。canvas を書き換える。"""
    img = sheet.img if isinstance(sheet, Sheet) else sheet
    rng = random.Random(seed)
    img = _paper_tone(img, seed, crease)
    sw, sh = img.size
    w, h = sw * scale, sh * scale
    cx, cy = center
    rad = math.radians(angle)
    corners = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    dst = []
    for x, y in corners:
        rx = x * math.cos(rad) - y * math.sin(rad) + cx + rng.uniform(-jitter, jitter)
        ry = x * math.sin(rad) + y * math.cos(rad) + cy + rng.uniform(-jitter, jitter)
        dst.append((rx, ry))
    src = [(0, 0), (sw, 0), (sw, sh), (0, sh)]
    co = _coeffs(dst, src)
    size = canvas.size
    mask_src = Image.new("L", (sw, sh), 255)
    warped = img.transform(size, Image.Transform.PERSPECTIVE, co, Image.Resampling.BICUBIC)
    mask = mask_src.transform(size, Image.Transform.PERSPECTIVE, co, Image.Resampling.BILINEAR)
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    if shadow:
        sm = mask.filter(ImageFilter.GaussianBlur(16)).point(lambda v: int(v * 0.42 * shadow))
        sm = ImageChops.offset(sm, 9, 14)
        dark = Image.new("RGB", size, (20, 16, 12))
        canvas.paste(dark, (0, 0), sm)
    canvas.paste(warped, (0, 0), mask)


def finish(canvas: Image.Image, seed: int = 0, light=(0.93, 1.06), blur=0.7, noise=2.6,
           out_long: int = 1700) -> Image.Image:
    """明るさのむら、暗い四隅、ぼけ、粒を足して、出力の大きさにする。"""
    rng = np.random.default_rng(seed + 991)
    a = np.asarray(canvas).astype("float32")
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    grad = light[0] + (light[1] - light[0]) * ((xx / w) * 0.6 + (1 - yy / h) * 0.4)
    vig = 1 - 0.20 * (((xx / w - 0.5) ** 2 + (yy / h - 0.5) ** 2) * 2)
    a *= (grad * vig)[..., None]
    a *= np.array([1.0, 0.99, 0.96])  # 室内灯のわずかな黄み
    a += rng.normal(0, noise, (h, w, 1)) + rng.normal(0, 0.8, (h, w, 3))
    im = Image.fromarray(np.clip(a, 0, 255).astype("uint8"), "RGB")
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    long = max(im.size)
    if long != out_long:
        k = out_long / long
        im = im.resize((round(im.width * k), round(im.height * k)), Image.Resampling.LANCZOS)
    return im


def save_jpeg(im: Image.Image, path: Path, quality: int = 80) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=quality, optimize=True)  # exif は付けない
