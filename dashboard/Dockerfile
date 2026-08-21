FROM node:22-alpine

# CastNexus dashboard + optional headless broadcast compositor.
# ffmpeg handles destination pushes, restreaming, compositor audio/video and VOD reruns.
# chromium renders CastNexus scenes/overlays and the 24/7 music spectrum.
# yt-dlp nightly resolves Twitch HLS/VOD and YouTube VOD media URLs.
# Deno is yt-dlp's recommended JavaScript runtime for current YouTube extraction.
RUN apk add --no-cache \
      ffmpeg \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont \
      dumb-init \
      python3 py3-pip \
      curl unzip bash

RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade --pre yt-dlp \
    && ln -sf /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && DENO_INSTALL=/usr/local curl -fsSL https://deno.land/install.sh | sh \
    && yt-dlp --version \
    && deno --version

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV YTDLP_BIN=/usr/local/bin/yt-dlp

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
CMD ["node", "server.js"]
