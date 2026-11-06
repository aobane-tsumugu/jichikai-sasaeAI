"""生成画像を手元で測る提供側用の入口。サーバーや外部APIへ送信しない。"""
import argparse
import hashlib
import json
from pathlib import Path
from evaluate import validate_manifest
from server import MODEL, YuNetEngine, process


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    validate_manifest(manifest)
    engine = YuNetEngine(args.model)
    root = args.manifest.resolve().parent
    predictions = {"kind": "local-yunet-inference", "model_sha256": MODEL["sha256"], "images": {}}
    for image in manifest["images"]:
        path = (root / image["file"]).resolve()
        if not path.is_relative_to(root):
            raise ValueError("画像は測定資料のディレクトリ内に置いてください")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != image["sha256"]:
            raise ValueError("測定画像のSHA-256が違います")
        try:
            output = process(data, engine)
            if (output["source_width"], output["source_height"]) != (image["width"], image["height"]):
                raise ValueError("測定画像の寸法が違います")
            predictions["images"][image["id"]] = {"status": "ok", "detections": output["detections"], "masks": output["masks"]}
        except Exception:
            predictions["images"][image["id"]] = {"status": "blocked", "detections": [], "masks": []}
    args.output.write_text(json.dumps(predictions, ensure_ascii=False, indent=2) + "\n")

