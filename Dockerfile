# syntax=docker/dockerfile:1.7
# dokploy-bridge: one Node.js process with no runtime dependencies, so the image is just Node
# plus src/. Configured by environment variables; state lives in /data.

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app

COPY package.json ./
COPY src ./src

# Runs as root so it can read Dokploy's build logs (/etc/dokploy/logs is root-only). Without that
# mount, any user that can write /data works.
VOLUME /data
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=2 CMD ["node", "src/healthcheck.mjs"]
CMD ["node", "src/index.mjs"]
