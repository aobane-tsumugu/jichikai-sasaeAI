"""保存済みの生成画像と実codecの確認。検出結果は代役で、重みを読み込まない。"""
import base64
import hashlib
import json
import math
import struct
import unittest
from pathlib import Path

import cv2
import numpy

from server import YuNetEngine, process


RESULTS = []
ROOT = Path(__file__).parent / "evaluation"


class CodecWithFakeDetections:
    """本番の復号・符号化を呼ぶ試験用の代役。YuNetEngineの起動ではない。"""
    def __init__(self, faces):
        self.cv, self.np = cv2, numpy
        self.faces = faces
        self.original_frame = None
        self.original_rgb = None
        self.masked_frame = None

    def decode(self, data):
        self.original_frame = YuNetEngine.decode(self, data)
        self.original_rgb = bytes(self.original_frame.rgb)
        return self.original_frame

    def detect(self, _frame, _deadline):
        # 正解枠を代役の検出結果にする。実検出や精度の測定には使わない。
        return [[*face, 0.25] for face in self.faces]

    def encode(self, frame):
        self.masked_frame = frame
        return YuNetEngine.encode(self, frame)


class CodecTest(unittest.TestCase):
    def test_generated_images_round_trip_with_opaque_masks_and_unchanged_sources(self):
        manifest = json.loads((ROOT / "manifest.json").read_text())
        for image in manifest["images"]:
            with self.subTest(image=image["id"]):
                path = ROOT / image["file"]
                source = path.read_bytes()
                source_hash = hashlib.sha256(source).hexdigest()
                self.assertEqual(source_hash, image["sha256"])
                engine = CodecWithFakeDetections(image["faces"])
                result = process(source, engine)
                self.assertEqual(engine.original_frame.rgb, engine.original_rgb)
                self.assertEqual(path.read_bytes(), source)
                self.assertEqual(result["source_sha256"], source_hash)
                self.assertEqual(len(result["masks"]), len(image["faces"]))
                original = numpy.frombuffer(engine.original_frame.rgb, dtype=numpy.uint8).reshape(image["height"], image["width"], 3)
                masked = numpy.frombuffer(engine.masked_frame.rgb, dtype=numpy.uint8).reshape(image["height"], image["width"], 3)
                self.assertTrue(numpy.any(original != masked))
                for face, cover in zip(image["faces"], result["masks"]):
                    x, y, w, h = cover
                    fx, fy, fw, fh = face
                    self.assertLessEqual(x, max(0, fx - 8))
                    self.assertLessEqual(y, max(0, fy - 8))
                    self.assertGreaterEqual(x + w, min(image["width"], fx + fw + 8))
                    self.assertGreaterEqual(y + h, min(image["height"], fy + fh + 8))
                    self.assertTrue(numpy.all(masked[y:y + h, x:x + w] == 0))
                png = base64.b64decode(result["png_base64"], validate=True)
                self.assertEqual(hashlib.sha256(png).hexdigest(), result["masked_sha256"])
                self.assertLessEqual(len(png), 600_000)
                self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(struct.unpack(">II", png[16:24]), (result["width"], result["height"]))
                kinds, offset = [], 8
                while offset < len(png):
                    size = struct.unpack(">I", png[offset:offset + 4])[0]
                    kinds.append(png[offset + 4:offset + 8])
                    offset += size + 12
                self.assertEqual(offset, len(png))
                self.assertEqual(kinds[0], b"IHDR")
                self.assertEqual(kinds[-1], b"IEND")
                self.assertTrue(set(kinds).issubset({b"IHDR", b"IDAT", b"IEND"}))
                decoded = cv2.imdecode(numpy.frombuffer(png, dtype=numpy.uint8), cv2.IMREAD_COLOR)
                self.assertIsNotNone(decoded)
                self.assertEqual(decoded.shape, (result["height"], result["width"], 3))
                # 縮小時の境界の混色を避け、覆いの内側が再符号化後も黒いことを確かめる。
                sx, sy = result["width"] / image["width"], result["height"] / image["height"]
                for x, y, w, h in result["masks"]:
                    left, top = math.ceil(x * sx) + 1, math.ceil(y * sy) + 1
                    right, bottom = math.floor((x + w) * sx) - 1, math.floor((y + h) * sy) - 1
                    self.assertGreater(right, left)
                    self.assertGreater(bottom, top)
                    self.assertTrue(numpy.all(decoded[top:bottom, left:right] == 0))
                output = Path("/tmp") / f"u34-codec-fake-{image['id']}.png"
                output.write_bytes(png)
                RESULTS.append({"image": image["id"], "source_sha256": source_hash,
                                "input_dimensions": [image["width"], image["height"]],
                                "fake_detections": len(image["faces"]), "source_unchanged": True,
                                "opaque_mask_pixels": True, "output_bytes": len(png),
                                "output_dimensions": [result["width"], result["height"]],
                                "output_sha256": result["masked_sha256"], "png_metadata_absent": True})


if __name__ == "__main__":
    unittest.main()

