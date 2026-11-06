# syntax=docker/dockerfile:1
# PM案の候補。作成・配備は本人の裁定後に提供側が行う。
FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS dependencies
WORKDIR /app
COPY requirements.txt ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      PIP_CERT=/run/secrets/proxy_ca python -m pip install --no-cache-dir -r requirements.txt; \
    else python -m pip install --no-cache-dir -r requirements.txt; fi
RUN python -c "import cv2, numpy; print({'opencv': cv2.__version__, 'numpy': numpy.__version__})"

# 重みが未取得でも依存のビルドだけは独立して検証できる。サービスの完成ではない。
FROM dependencies AS runtime
COPY server.py model.json ./
COPY models/yunet.onnx models/LICENSE-YUNET ./models/
# 重みが無い・違う場合はビルドも起動も失敗させる。実行時の取得はしない。
RUN python -c "from server import verify_model; verify_model('models/yunet.onnx')"
ENV PYTHONDONTWRITEBYTECODE=1 OPENCV_IO_MAX_IMAGE_PIXELS=12000000
USER 65532:65532
EXPOSE 8080
CMD ["python", "server.py"]

