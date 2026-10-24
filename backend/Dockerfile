# Python 网关镜像（ComfyUI + 百炼转发）：只跑 FastAPI，无数据库，data 目录挂 volume 持久化。
FROM python:3.12-slim

WORKDIR /app/backend
COPY requirements.txt ./
# 视频复刻要在网关本机裁剪片段、回贴原声，镜像里带上 ffmpeg。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir -r requirements.txt

COPY . ./
RUN mkdir -p /app/backend/data

EXPOSE 8787
# 容器里要接受来自 nginx 的请求，故 host 设为 0.0.0.0；数据仍只在本服务内。
ENV COMFY_GATEWAY_HOST=0.0.0.0
CMD ["python", "main.py"]
