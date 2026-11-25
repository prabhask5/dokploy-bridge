# dokploy-bridge: no dependencies, so the image is just Node plus the source.
FROM node:22-alpine

LABEL org.opencontainers.image.title="dokploy-bridge" \
      org.opencontainers.image.description="Vercel-style defaults, GitHub Deployments + checks, and preview cleanup for self-hosted Dokploy" \
      org.opencontainers.image.source="https://github.com/prabhask5/dokploy-bridge" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production DATA_DIR=/data
VOLUME ["/data"]

# Runs as root by default so it can read Dokploy's build logs (/etc/dokploy/logs is root-only).
# If you don't mount the logs, you can run it as any user that can write /data.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=2 CMD ["node", "src/healthcheck.mjs"]
CMD ["node", "src/index.mjs"]
