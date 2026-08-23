FROM node:22-bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

ARG CASTNEXUS_VERSION=0.0.0-dev
ARG CASTNEXUS_CHANNEL=dev
ARG CASTNEXUS_REVISION=unknown
ENV CASTNEXUS_VERSION=${CASTNEXUS_VERSION}
ENV CASTNEXUS_CHANNEL=${CASTNEXUS_CHANNEL}
ENV CASTNEXUS_INSTALL_TYPE=docker

LABEL org.opencontainers.image.title="CastNexus VRChat Relay" \
      org.opencontainers.image.description="AAC-only RTSP relay for CastNexus VRChat MPEG-TS HLS compatibility" \
      org.opencontainers.image.version="${CASTNEXUS_VERSION}" \
      org.opencontainers.image.revision="${CASTNEXUS_REVISION}"

WORKDIR /app
COPY vrchat-relay.js ./vrchat-relay.js

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "vrchat-relay.js"]
