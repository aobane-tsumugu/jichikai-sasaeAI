# 提供側で顔を隠す部品

PR #62のYuNet処理を土台に、L-260とL-264の任意の手直しを接続した。写真を保存せず、外部APIも実行中のモデル取得も持たない。WorkerのDurable Objectが`enableInternet:false`で起動する。実Containerでの通信制限は未確認。

入力はPNG/JPEG、手直しはJSON（元の写真のbase64、mode、写真全体を1としたmasks）。自動検出は原寸の重なるタイルと4方向を使い、広い不透明な覆いを掛ける。同じ顔の重なる覆いはまとめ、一度押せば外せるようにした。手直しは送られた範囲を提供側で掛け直す。noneでも元のファイルを返さず、PNGに符号化してメタデータを落とす。検出ゼロ・例外・時間切れは自動処理の失敗とし、公開しない。

2026-11-07にモデル取得と固定SHA-256の照合、Windows上の実モデルの評価を実行した。結果と限界は[写真の記録](../../src/photos/README.md)、再現手順は[RUNBOOK](../../docs/RUNBOOK.md)。Dockerの完全ビルド、Cloudflareでの起動、実機の性能は未確認。

## モデルと権利

OpenCV ZooのYuNet 2023marを用いる。固定のcommit、公式URL、長さ、SHA-256はmodel.json、通知はmodels/LICENSE-YUNET。OpenCV4.12.0はApache-2.0、当該YuNetディレクトリは重みを含む全ファイルをMITと明示している。

- [OpenCV4.12.0のライセンス](https://github.com/opencv/opencv/blob/4.12.0/LICENSE)
- [YuNetの固定版のライセンス説明](https://github.com/opencv/opencv_zoo/blob/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet/README.md#license)
- [YuNetのMIT通知](https://github.com/opencv/opencv_zoo/blob/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet/LICENSE)

PR #62ではInsightFaceの配布モデルとも比較した。[その配布モデルは非商用研究用](https://github.com/deepinsight/insightface#license)との説明があるため採っていない。RetinaFaceという方式全体の権利判断ではない。
