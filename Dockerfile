# Free daily vertical video automation - server image (Render / Koyeb / Railway / Cloud Run).
# ffmpeg (render), espeak-ng (free offline TTS), DejaVu fonts (titles).
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      espeak-ng \
      fonts-dejavu-core \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Optional: neural voices (bigger image, slower synthesis).
# RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
#       && pip3 install --no-cache-dir --break-system-packages piper-tts \
#       && ln -sf "$(command -v piper)" /usr/local/bin/piper \
#       && apt-get purge -y python3-pip && rm -rf /var/lib/apt/lists/*
# then set PIPER_VOICE=/opt/voices/en_US-amy-medium.onnx

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production \
    FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
    OLLAMA_BASE_URL= \
    OLLAMA_MODEL=llama3.2:1b \
    TTS_ENGINE=auto \
    OUTPUT_DIR=/app/output \
    SCHEDULER_ENABLED=true

EXPOSE 8080

HEALTHCHECK --interval=10m --timeout=10s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:${PORT:-8080}/health || exit 1

CMD ["node", "src/index.js", "--serve"]