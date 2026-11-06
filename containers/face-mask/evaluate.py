"""生成した集合写真の正解範囲と検出結果を照合する。写真を送信しない。"""
import argparse
import json
import math
from pathlib import Path


def box(value, width, height):
    if not isinstance(value, list) or len(value) < 4 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        raise ValueError("範囲が不正です")
    x, y, w, h = value[:4]
    if not (x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= width and y + h <= height):
        raise ValueError("範囲が画像の外です")
    return x, y, w, h


def intersection(a, b):
    return max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])) * max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))


def size_group(face):
    side = min(face[2], face[3])
    return "under16" if side < 16 else "16to31" if side < 32 else "32to95" if side < 96 else "96plus"


def validate_manifest(manifest):
    if manifest.get("synthetic") is not True or not isinstance(manifest.get("images"), list) or not manifest["images"]:
        raise ValueError("架空の画像であることと画像の一覧が必要です")
    seen = set()
    for image in manifest["images"]:
        if not isinstance(image.get("id"), str) or image["id"] in seen:
            raise ValueError("画像の番号が重複しています")
        seen.add(image["id"])
        if image.get("provenance", {}).get("kind") != "generated" or image.get("synthetic") is not True:
            raise ValueError("生成した架空人物の画像だけを使います")
        width, height = image["width"], image["height"]
        if not all(type(v) is int and 0 < v <= 10000 for v in [width, height]):
            raise ValueError("寸法が不正です")
        if not isinstance(image.get("faces"), list):
            raise ValueError("正解範囲の一覧がありません")
        for face in image["faces"]:
            box(face, width, height)


def evaluate(manifest, predictions=None):
    validate_manifest(manifest)
    example = predictions is not None and predictions.get("kind") == "tool-example"
    if predictions is not None and predictions.get("kind") not in ("tool-example", "local-yunet-inference"):
        raise ValueError("測定結果の来歴がありません")
    rows = {} if predictions is None else predictions.get("images", {})
    groups = {name: {"annotated": 0, "evaluated": 0, "missed": 0, "not_fully_covered": 0}
              for name in ["under16", "16to31", "32to95", "96plus"]}
    unmeasured, blocked = [], []
    for image in manifest["images"]:
        result = rows.get(image["id"])
        if result is None:
            unmeasured.append(image["id"])
        elif result.get("status") not in ("ok", "blocked"):
            raise ValueError("測定の状態が不正です")
        elif result["status"] == "blocked":
            blocked.append(image["id"])
        available = [] if result is None or result["status"] == "blocked" else [box(b, image["width"], image["height"]) for b in result["detections"]]
        masks = [] if result is None or result["status"] == "blocked" else [box(b, image["width"], image["height"]) for b in result["masks"]]
        used = set()
        for face in image["faces"]:
            face = box(face, image["width"], image["height"])
            group = groups[size_group(face)]
            group["annotated"] += 1
            if result is None:
                continue
            group["evaluated"] += 1
            candidates = [(intersection(face, found) / (face[2] * face[3] + found[2] * found[3] - intersection(face, found)), i)
                          for i, found in enumerate(available) if i not in used]
            overlap, index = max(candidates, default=(0, -1))
            if overlap >= 0.3:
                used.add(index)
            else:
                group["missed"] += 1
            # 一つの覆いで正解の95%以上を隠せるか。複数の覆いの和で水増ししない。
            if max((intersection(face, mask) / (face[2] * face[3]) for mask in masks), default=0) < 0.95:
                group["not_fully_covered"] += 1
    for group in groups.values():
        group["miss_rate"] = group["missed"] / group["evaluated"] if group["evaluated"] else None
    return {"measurement": "unmeasured" if predictions is None else "tool-example" if example else "local-yunet-inference",
            "model_sha256": None if predictions is None else predictions.get("model_sha256"),
            "groups": groups, "unmeasured_images": unmeasured, "blocked_images": blocked,
            "matching_iou": 0.3, "required_mask_coverage": 0.95}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--predictions", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = evaluate(json.loads(args.manifest.read_text()),
                      json.loads(args.predictions.read_text()) if args.predictions else None)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

