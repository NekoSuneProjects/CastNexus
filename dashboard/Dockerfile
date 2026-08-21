FROM node:22-bookworm-slim

# CastNexus dashboard + optional headless broadcast compositor.
# Debian is intentional here: Deno's official Linux binaries target GNU/Linux,
# while Alpine/musl can fail at runtime even when the installer succeeds.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
      ca-certificates \
      fonts-freefont-ttf \
      dumb-init \
      python3 python3-venv \
      curl unzip bash \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp nightly is its recommended regular-use channel. Deno is the
# recommended JavaScript runtime for current YouTube extraction.
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade --pre yt-dlp \
    && ln -sf /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && export DENO_INSTALL=/usr/local \
    && curl -fsSL https://deno.land/install.sh | sh \
    && yt-dlp --version \
    && deno --version

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV YTDLP_BIN=/usr/local/bin/yt-dlp
# Chromium + FFmpeg can take tens of seconds to warm up on Raspberry Pi.
# Older custom Compose files don't pass this variable, so keep a safe image default.
ENV MUSIC24_START_TIMEOUT_MS=60000

ARG CASTNEXUS_VERSION=0.0.0-dev
ARG CASTNEXUS_CHANNEL=dev
ARG CASTNEXUS_REVISION=unknown
ENV CASTNEXUS_VERSION=${CASTNEXUS_VERSION}
ENV CASTNEXUS_CHANNEL=${CASTNEXUS_CHANNEL}
ENV CASTNEXUS_INSTALL_TYPE=docker

LABEL org.opencontainers.image.title="CastNexus Dashboard" \
      org.opencontainers.image.description="Self-hosted multi-source restreaming, overlays, profile VOD reruns and 24/7 music studio" \
      org.opencontainers.image.version="${CASTNEXUS_VERSION}" \
      org.opencontainers.image.revision="${CASTNEXUS_REVISION}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8090

ENTRYPOINT ["dumb-init", "--"]
# server-entry starts the Studio plus the Music 24/7 worker in one runtime.
# A reachable dashboard can therefore no longer exist without its radio worker.
CMD ["node", "server-entry.js"]
