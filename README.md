# dokploy-bridge

Vercel-style glue between a self-hosted [Dokploy](https://dokploy.com) and GitHub, for every Dokploy app:

1. **Defaults:** new apps get the build type, rollback registry and preview settings frozen from a template app (`data/defaults.json`).
2. **GitHub Deployments and checks:** every Dokploy deploy becomes a GitHub Deployment (`Production` / `Preview (PR #n)`) and a check run that shows a spinner while building and ends ✅/❌ with a report (URL, build time, or the error and the end of the build log, with secrets masked).
3. **Cleanup:** when a PR closes and Dokploy removes its preview, the GitHub deployment is retired.

It talks to Dokploy over its internal network with an API key, and to GitHub as Dokploy's own GitHub App (needs Checks, Deployments and Commit statuses: Read and write).

## Run

**Via Dokploy (normal):** Dockerfile app from this repo, previews **off**, env from `.env.example`, mounts:
- `/opt/services/dokploy-bridge/data` -> `/data`
- `/etc/dokploy/logs` -> `/etc/dokploy/logs` (read-only, for build-log tails)

**Fallback (Dokploy itself broken):** `cp .env.example .env`, fill it in, `docker compose up -d`.

Only ever run one instance at a time.
