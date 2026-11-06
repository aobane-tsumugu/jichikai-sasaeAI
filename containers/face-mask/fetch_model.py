"""提供側のビルド準備用。実行中のサービスからは呼ばない。"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name("model.json").read_text())
    with urlopen(manifest["url"], timeout=30) as response:
        data = response.read(manifest["size"] + 1)
    if len(data) != manifest["size"] or hashlib.sha256(data).hexdigest() != manifest["sha256"]:
        raise SystemExit("モデルの長さかSHA-256が一致しません。保存していません。")
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    # 既存のモデルを上書きしない。
    with args.destination.open("xb") as output:
        output.write(data)

