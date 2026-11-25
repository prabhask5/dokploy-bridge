# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-25

First public release.

### Added
- GitHub Deployments and check runs for every Dokploy production and preview deployment, with a build report (URL, build time, or error and the end of the build log, with env values masked).
- In-progress checks while Dokploy builds, even on Dokploy versions that only record a deployment when the build ends; stale ones are closed after 2 minutes.
- Preview cleanup: when a PR closes, its GitHub deployments and `Preview (PR #n)` environment are deleted, plus a one-time sweep of environments left behind earlier.
- Defaults for new apps captured once from a template app into `defaults.json`; preview port follows the first domain; previews inherit production env vars until customised.
- Configuration for every feature and name, per-app opt-out (`dokploy-bridge: off` in the description or `IGNORE_APPS`), `DRY_RUN`, `LOG_LEVEL`.
- Multi-arch Docker image on GHCR, unit tests, CI.

### Upgrading from the pre-release single-file bridge
- `state.json` and `defaults.json` are compatible: mount the same data folder and nothing is reported twice.
- `DOKPLOY_INTERNAL_URL` still works (`DOKPLOY_URL` is the new name).
- If you renamed the checks in the old script, set `CHECK_NAME_PRODUCTION` / `CHECK_NAME_PREVIEW` to the same names.
- The health check is now `node src/healthcheck.mjs` (built into the image).

[Unreleased]: https://github.com/prabhask5/dokploy-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/prabhask5/dokploy-bridge/releases/tag/v0.1.0
