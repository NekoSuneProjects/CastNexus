FROM node:22-alpine

# CastNexus dashboard + optional headless broadcast compositor.
# ffmpeg handles destination pushes, restreaming and compositor audio/video.
# chromium renders CastNexus scenes/overlays and the 24/7 music spectrum.
RUN apk add --no-cache \
      ffmpeg \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont \
      dumb-init

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

ARG CASTNEXUS_VERSION=0.0.0-dev
ARG CASTNEXUS_CHANNEL=dev
ARG CASTNEXUS_REVISION=unknown
ENV CASTNEXUS_VERSION=${CASTNEXUS_VERSION}
ENV CASTNEXUS_CHANNEL=${CASTNEXUS_CHANNEL}
ENV CASTNEXUS_INSTALL_TYPE=docker

LABEL org.opencontainers.image.title="CastNexus Dashboard" \
      org.opencontainers.image.description="Self-hosted multi-source restreaming, overlays and 24/7 music studio" \
      org.opencontainers.image.version="${CASTNEXUS_VERSION}" \
      org.opencontainers.image.revision="${CASTNEXUS_REVISION}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8090

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
