# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Ground rules
- **No runtime dependencies.** The bridge is plain Node.js (22+) using only the standard library; please keep it that way.
- **Keep it safe by default.** Anything that writes to Dokploy or GitHub should respect `DRY_RUN` (the clients already do) and have a config switch if it's a new behaviour.
- **Tests for behaviour changes.** `test/helpers.mjs` has a fake GitHub and helpers for Dokploy responses; most features can be tested without a real server.

## Layout
| File | What it does |
|---|---|
| `src/index.mjs` | Main loop: lists apps, applies defaults, syncs each app, writes the heartbeat |
| `src/config.mjs` | Environment variables to config, with validation |
| `src/clients.mjs` | Dokploy API client; GitHub client authenticating as Dokploy's GitHub App |
| `src/defaults.mjs` | Defaults for new apps, preview port and env inheritance |
| `src/reporting.mjs` | Deployments, check runs, commit-status fallback, in-progress checks |
| `src/cleanup.mjs` | Removing closed PRs' deployments and environments |
| `src/sync.mjs` | Per-app orchestration of reporting and cleanup |
| `src/util.mjs` | Pure helpers |

## Workflow
```bash
npm run check && npm test
```
To try changes against a real Dokploy without touching anything, run with `DRY_RUN=true ONCE=true LOG_LEVEL=debug`.

Add a line under **Unreleased** in `CHANGELOG.md` for user-visible changes.

## Releasing (maintainers)
1. Move the Unreleased notes under a new version in `CHANGELOG.md`, bump `version` in `package.json`.
2. Commit, then `git tag vX.Y.Z && git push --tags`. The Release workflow publishes the image to GHCR and creates the GitHub release.
