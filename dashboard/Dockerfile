FROM node:22-alpine

# ffmpeg: destination pushes, republish, and the compositor's encode.
# chromium + fonts: the optional built-in overlay compositor (see
# dashboard/compositor.js) - a headless Chromium instance that renders the
# account's own live feed + overlays as one page and re-encodes it, the same
# mechanism CacheStream uses (github.com/NekoSuneProjectsForks/NekoStreamAPP,
# `docker` branch, apps/streamer/src/stream.js). Off by default per-account;
# these packages just make the option available.
RUN apk add --no-cache \
      ffmpeg \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont \
      dumb-init

# puppeteer-core has no bundled Chromium to skip downloading, but the flag
# also silences a startup warning some puppeteer-core versions emit anyway.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8090

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
