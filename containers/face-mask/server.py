"""PM案の候補。写真の保存、外部API、実行時のモデル取得を持たない。"""
import base64
import hashlib
import json
import math
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from time import monotonic

PROFILE = "yunet-report-v2"
MODEL = json.loads(Path(__file__).with_name("model.json").read_text())
SCORE_THRESHOLD = 0.2
MAX_FACES = 2000
MAX_BYTES = 8_000_000
MAX_PIXELS = 12_000_000


@dataclass(frozen=True)
class Frame:
    width: int
    height: int
    rgb: bytes


def verify_model(path):
    data = Path(path).read_bytes()
    if len(data) != MODEL["size"] or hashlib.sha256(data).hexdigest() != MODEL["sha256"]:
        raise ValueError("モデルが一致しません")


def mask_frame(frame, detections):
    """不透明な覆いを広く掛け、入力の画素は保持する。"""
    if not (0 < frame.width <= 10000 and 0 < frame.height <= 10000) or frame.width * frame.height > MAX_PIXELS:
        raise ValueError("画像の寸法が不正です")
    if len(frame.rgb) != frame.width * frame.height * 3:
        raise ValueError("画像が途中で切れています")
    boxes = []
    for value in detections:
        if len(value) != 5 or not all(math.isfinite(number) for number in value):
            raise ValueError("検出範囲が不正です")
        x, y, width, height, score = value
        if not (0 <= score <= 1 and width > 0 and height > 0 and x >= 0 and y >= 0 and
                x + width <= frame.width and y + height <= frame.height):
            raise ValueError("検出範囲が画像の外です")
        if score < SCORE_THRESHOLD:
            continue
        mx, my = max(8, width * 0.4), max(8, height * 0.4)
        left, top = max(0, math.floor(x - mx)), max(0, math.floor(y - my))
        right = min(frame.width, math.ceil(x + width + mx))
        bottom = min(frame.height, math.ceil(y + height + my))
        boxes.append([left, top, right - left, bottom - top])
    if not boxes or len(boxes) >= MAX_FACES:
        raise ValueError("検出ゼロか上限に達しました")
    # 同じ顔が別方向・別タイルで見つかった覆いは一つにし、一度押すと外せるようにする。
    merged = []
    for box in boxes:
        x, y, w, h = box
        index = 0
        while index < len(merged):
            a, b, c, d = merged[index]
            overlap = max(0, min(x+w, a+c)-max(x, a)) * max(0, min(y+h, b+d)-max(y, b))
            if overlap >= min(w*h, c*d) * 0.5:
                right, bottom = max(x+w, a+c), max(y+h, b+d)
                x, y = min(x, a), min(y, b)
                w, h = right-x, bottom-y
                merged.pop(index)
                index = 0
            else:
                index += 1
        merged.append([x, y, w, h])
    boxes = merged
    output = bytearray(frame.rgb)
    for x, y, width, height in boxes:
        for row in range(y, y + height):
            start = (row * frame.width + x) * 3
            output[start:start + width * 3] = bytes(width * 3)
    return Frame(frame.width, frame.height, bytes(output)), boxes


def tile_starts(length, tile=640, stride=480):
    if length <= tile:
        return [0]
    return sorted(set([*range(0, length - tile + 1, stride), length - tile]))


class YuNetEngine:
    def __init__(self, model_path):
        verify_model(model_path)
        import cv2
        import numpy
        self.cv, self.np = cv2, numpy
        cv2.setNumThreads(1)
        cv2.ocl.setUseOpenCL(False)
        self.detector = cv2.FaceDetectorYN.create(str(model_path), "", (640, 640), SCORE_THRESHOLD, 0.3, 5000)

    def decode(self, data):
        # EXIFに表示の向きを任せず、4方向の検出と同じ画素で出力する。
        image = self.cv.imdecode(self.np.frombuffer(data, dtype=self.np.uint8),
                                 self.cv.IMREAD_COLOR | self.cv.IMREAD_IGNORE_ORIENTATION)
        if image is None:
            raise ValueError("画像を復号できません")
        height, width = image.shape[:2]
        if width * height > MAX_PIXELS or max(width, height) > 10000:
            raise ValueError("画像が大きすぎます")
        rgb = self.cv.cvtColor(image, self.cv.COLOR_BGR2RGB).tobytes()
        return Frame(width, height, rgb)

    def detect(self, frame, deadline):
        image = self.np.frombuffer(frame.rgb, dtype=self.np.uint8).reshape((frame.height, frame.width, 3))
        image = self.cv.cvtColor(image, self.cv.COLOR_RGB2BGR)
        boxes = []
        # 元の解像度の重なったタイルを使う。全体の縮小だけで小さい顔を失わない。
        windows = [(image[y:y + 640, x:x + 640], x, y, 1.0)
                   for y in tile_starts(frame.height) for x in tile_starts(frame.width)]
        ratio = min(1.0, 1280 / max(frame.width, frame.height))
        if ratio < 1:
            windows.append((self.cv.resize(image, None, fx=ratio, fy=ratio), 0, 0, ratio))
        for window, ox, oy, scale in windows:
            height, width = window.shape[:2]
            for rotation in range(4):
                if monotonic() > deadline:
                    raise TimeoutError("検出が時間切れです")
                rotated = self.np.ascontiguousarray(self.np.rot90(window, rotation))
                self.detector.setInputSize((rotated.shape[1], rotated.shape[0]))
                _, faces = self.detector.detect(rotated)
                if faces is None:
                    continue
                for face in faces:
                    if len(face) != 15 or not all(math.isfinite(float(number)) for number in face) or not (0 <= float(face[-1]) <= 1):
                        raise ValueError("検出結果が不正です")
                    x, y, w, h = map(float, face[:4])
                    if w <= 0 or h <= 0:
                        raise ValueError("検出範囲が不正です")
                    if rotation == 1:
                        x, y, w, h = width - y - h, x, h, w
                    elif rotation == 2:
                        x, y = width - x - w, height - y - h
                    elif rotation == 3:
                        x, y, w, h = y, height - x - w, h, w
                    left, top = max(0, x), max(0, y)
                    right, bottom = min(width, x + w), min(height, y + h)
                    if right <= left or bottom <= top:
                        raise ValueError("検出が画像の外です")
                    boxes.append([(left / scale) + ox, (top / scale) + oy,
                                  (right - left) / scale, (bottom - top) / scale, float(face[-1])])
                    if len(boxes) >= MAX_FACES:
                        raise ValueError("検出上限に達しました")
                if monotonic() > deadline:
                    raise TimeoutError("検出が時間切れです")
        return boxes

    def encode(self, frame):
        image = self.np.frombuffer(frame.rgb, dtype=self.np.uint8).reshape((frame.height, frame.width, 3))
        image = self.cv.cvtColor(image, self.cv.COLOR_RGB2BGR)
        ratio = min(1.0, 1280 / max(frame.width, frame.height))
        for _ in range(7):
            width, height = max(1, round(frame.width * ratio)), max(1, round(frame.height * ratio))
            resized = self.cv.resize(image, (width, height), interpolation=self.cv.INTER_AREA)
            ok, png = self.cv.imencode(".png", resized, [self.cv.IMWRITE_PNG_COMPRESSION, 9])
            if not ok:
                raise ValueError("写真を符号化できません")
            if len(png) <= 600_000:
                return png.tobytes(), width, height
            ratio *= 0.75
        raise ValueError("出力が大きすぎます")


def process(data, engine, edit=None):
    if not data or len(data) > MAX_BYTES or not (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff")):
        raise ValueError("入力の形式が違います")
    deadline = monotonic() + 12
    frame = engine.decode(data)
    if edit is None:
        detections = engine.detect(frame, deadline)
        masked, boxes = mask_frame(frame, detections)
    else:
        mode = edit.get("mode")
        ranges = edit.get("masks")
        if mode not in ("manual", "none") or not isinstance(ranges, list) or len(ranges) > MAX_FACES:
            raise ValueError("隠す範囲が不正です")
        detections, boxes = [], []
        if mode == "manual":
            for box in ranges:
                values = [box[k] for k in ("x", "y", "width", "height")]
                if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values):
                    raise ValueError("隠す範囲が不正です")
                x, y, w, h = values
                if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > 1.000001 or y+h > 1.000001:
                    raise ValueError("隠す範囲が画像の外です")
                left, top = math.floor(x*frame.width), math.floor(y*frame.height)
                right, bottom = min(frame.width, math.ceil((x+w)*frame.width)), min(frame.height, math.ceil((y+h)*frame.height))
                boxes.append([left, top, right-left, bottom-top])
        output = bytearray(frame.rgb)
        for x, y, w, h in boxes:
            for row in range(y, y+h):
                start = (row*frame.width+x)*3
                output[start:start+w*3] = bytes(w*3)
        masked = Frame(frame.width, frame.height, bytes(output))
    png, width, height = engine.encode(masked)
    if monotonic() > deadline or not png or len(png) > 600_000:
        raise ValueError("処理が終わりませんでした")
    return {"state": "masked", "source_sha256": hashlib.sha256(data).hexdigest(),
            "masked_sha256": hashlib.sha256(png).hexdigest(), "model_sha256": MODEL["sha256"], "profile": PROFILE,
            "png_base64": base64.b64encode(png).decode("ascii"), "width": width, "height": height,
            "faces": len(boxes), "detections": detections, "masks": boxes,
            "source_width": frame.width, "source_height": frame.height}


def handler_for(engine):
    busy = Lock()

    class Handler(BaseHTTPRequestHandler):
        # 本文、URL、ヘッダーをログへ残さない。
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_response(200 if self.path == "/health" else 404)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            if self.path != "/mask":
                self.send_error(404)
                return
            if not busy.acquire(blocking=False):
                self.send_error(503)
                return
            status, result = 422, {"state": "blocked"}
            try:
                self.connection.settimeout(15)
                lengths = self.headers.get_all("Content-Length", [])
                types = self.headers.get_all("Content-Type", [])
                # 重複や空のTransfer-Encodingを先頭の値だけで受け入れない。
                if self.headers.get_all("Transfer-Encoding") is not None or len(lengths) != 1 or len(types) != 1:
                    raise ValueError("入力が不正です")
                raw_length = lengths[0].strip()
                if not raw_length.isascii() or not raw_length.isdecimal():
                    raise ValueError("入力の長さが不正です")
                length = int(raw_length)
                limit = 11_000_000 if types[0] == "application/json" else MAX_BYTES
                if not 0 < length <= limit or types[0] not in ("image/jpeg", "image/png", "application/json"):
                    raise ValueError("入力が不正です")
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("入力が途中で切れています")
                edit = None
                if types[0] == "application/json":
                    edit = json.loads(data)
                    data = base64.b64decode(edit["image_base64"], validate=True)
                result = process(data, engine, edit)
                result["masks"] = [{"x": x/result["source_width"], "y": y/result["source_height"],
                                    "width": w/result["source_width"], "height": h/result["source_height"]}
                                   for x, y, w, h in result["masks"]]
                status = 200
            except Exception:
                # 写真の中身、モデルやファイルのパス、例外の本文は返さない。
                pass
            finally:
                busy.release()
            body = json.dumps(result, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    return Handler


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), handler_for(YuNetEngine(Path(__file__).parent / "models/yunet.onnx"))).serve_forever()

