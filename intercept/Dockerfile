FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dsniff iptables iproute2 procps \
    && rm -rf /var/lib/apt/lists/*

COPY intercept.sh /intercept.sh
RUN chmod +x /intercept.sh

ENTRYPOINT ["/intercept.sh"]
