FROM node:22-alpine
WORKDIR /app
COPY bridge.mjs .
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=2 \
  CMD node -e "process.exit(Date.now()-Number(require('fs').readFileSync('/tmp/heartbeat','utf8'))<180000?0:1)"
CMD ["node", "bridge.mjs"]
