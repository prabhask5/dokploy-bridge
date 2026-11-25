# dokploy-bridge

Context for agents and maintainers. This file and the code are the whole truth; there is no other design document.

## 1. What it is

A companion service for a self-hosted Dokploy that adds what Vercel does on GitHub:

- a check run and a GitHub Deployment for every production and preview deploy
- cleanup of a pull request's preview environment when it closes
- defaults for newly created apps

One long-running Node.js process, plain JavaScript (ES modules), **no runtime dependencies**. It polls Dokploy's API and acts on GitHub as the GitHub App Dokploy already uses. It runs as a container on the Dokploy server.

Principles, used to break ties:

1. **Never surprise the owner.** Existing apps and deployments are left alone, every feature can be switched off, and `DRY_RUN` shows any change before it's made.
2. **Never get stuck.** A check must always end, even if Dokploy never writes a record. An error in one app never stops the others.
3. **Nothing per repository.** No webhooks, no workflow files, no second GitHub App.

## 2. Architecture

| Path                  | What it is                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `src/index.mjs`       | Main loop: `createContext()`, `tick()`, `main()`                                         |
| `src/config.mjs`      | Environment variables → `cfg`, with validation. `loadConfig(env)` is pure.               |
| `src/log.mjs`         | Timestamped logger; `log.once(key, …)` for warnings that shouldn't repeat every tick     |
| `src/store.mjs`       | `state.json`, loaded once and written atomically (temp file + rename)                    |
| `src/clients.mjs`     | `dk()`: Dokploy API client. `gh()`: GitHub client authenticating as Dokploy's GitHub App |
| `src/util.mjs`        | Pure helpers: SHA parsing, URLs, secret masking, environment-name templates, opt-out     |
| `src/defaults.mjs`    | Feature 1: defaults for new apps, preview port, preview env inheritance                  |
| `src/reporting.mjs`   | Feature 2: deployments, check runs, commit-status fallback, in-progress checks           |
| `src/cleanup.mjs`     | Feature 3: deleting closed PRs' deployments and environments                             |
| `src/sync.mjs`        | Per-app orchestration of features 2 and 3                                                |
| `src/healthcheck.mjs` | Container `HEALTHCHECK`: exit 0 if the last tick finished recently                       |
| `tests/`              | Every test (see [tests/README.md](tests/README.md))                                      |
| `scripts/`            | `check-links.mjs`, run in CI                                                             |

### A tick (every `POLL_SECONDS`)

1. `GET project.all`, and collect every application, deduplicated by `applicationId`. Newer Dokploy versions nest apps under `environments[]`, older ones list them on the project; both are read.
2. For each app that isn't ignored (`dokploy-bridge: off` in its description, or listed in `IGNORE_APPS`):
   1. `GET application.one` for the full app: domains, env, recent deployments.
   2. `applyDefaults()`, only for apps created after the bridge's first run.
   3. `syncApp()`, only for apps using the GitHub provider:
      - report production deployments
      - report preview deployments (`GET previewDeployment.all`)
      - retire previews Dokploy removed
      - the once-per-start orphan sweep
3. Save state, and write the heartbeat file.

An error in one app is logged and the loop moves on to the next app. A failed tick (for example Dokploy being down) is logged, and the next tick tries again.

### The context

Everything shares one object built by `createContext(cfg, overrides)`. Feature code never imports the clients directly, so tests swap in fakes through `overrides`:

```js
{ cfg, log, store: { state, save }, dk, gh, flags: { checksUnavailable }, swept: Set }
```

### GitHub access

There's no GitHub App of the bridge's own:

1. `GET github.one` returns Dokploy's app ID, installation ID and private key. Only owner and admin API keys can read the key.
2. `gh()` signs a 9-minute RS256 JWT with it and exchanges that for an installation token, cached for 50 minutes per provider.
3. The API base is `https://api.github.com`, or `<githubUrl>/api/v3` for GitHub Enterprise Server, unless `GITHUB_API_URL` overrides it.

Errors are `HttpError`s with a `.status`, and feature code branches on `.status`, never on message text.

## 3. State

`state.json` in `DATA_DIR`. **Its shape is a compatibility promise**, because running installs depend on it: add fields, don't rename or repurpose them.

| Key                             | Shape                                                              | Meaning                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `baselined`                     | bool                                                               | Set after the first tick. On that tick, existing deployments are recorded with `skipped: true` and not reported. |
| `apps[applicationId]`           | `{ baseline, defaults, previewPortSynced, previewEnvWritten }`     | `baseline: true` means the app existed before the bridge, so defaults never touch it.                            |
| `reported[deploymentId]`        | `{ gh, check, repo, sha, checkName, status, skipped?, noted? }`    | Dokploy deployment → GitHub deployment and check run. Reported again only when `status` changes.                 |
| `previews[previewDeploymentId]` | `{ repo, githubId, environment, gh: [ids], tries? }`               | Live previews, so they can be cleaned up when Dokploy removes them. `tries` caps failed cleanups at 5.           |
| `pending[key]`                  | `{ repo, sha, gh, check, checkName, environment, at, stoppedAt? }` | In-progress checks posted before Dokploy wrote a record. Key: `<appId>\|prod` or `<appId>\|pr<n>`.               |

`defaults.json` holds the settings captured from `TEMPLATE_APP`: the keys in `BUILD_KEYS` and `UPDATE_KEYS` in `defaults.mjs`. It's never env vars or domains.

## 4. Invariants and conventions

- **No runtime dependencies.** `src/` imports only `node:` modules. Dev tools (Prettier, ESLint) are dev dependencies only, and the image contains just `package.json` and `src/`.
- **Every write respects `DRY_RUN`.** The clients turn non-GET requests into log lines and fake ids, so new writes should go through `dk()` / `gh()`, never a raw `fetch`.
- **New behaviour gets a setting** with a default that keeps the current behaviour, in `config.mjs`, `.env.example` and the README table.
- **A check must always end.** Anything that starts an `in_progress` check must leave a path to complete it. That path is `report()`, or else `settleStale()` after `PENDING_TIMEOUT_MS` (2 minutes).
- **Dokploy quirks the code depends on:**
  - The commit is only in the deployment's description, as `Hash: <sha>` while running or `Commit: <sha>` when done, depending on the version. That's why `shaOf()` accepts both.
  - Some versions write the deployment record only when the build ends. Hence `markBuilding()` + `pending`.
  - Build logs are files at `deployment.logPath` on the host. They're readable only if `/etc/dokploy/logs` is mounted at the same path.
- **Secrets never reach GitHub unmasked.** Everything taken from a build log goes through `stripAnsi()` and `maskSecrets()` with the app's env, preview env and build args.
- **Logging:** `log.info` for things the owner should see, `log.debug` for detail, `log.once` for permission and configuration warnings.
- **Formatting and lint:** Prettier (`.prettierrc.json`: double quotes, trailing commas, 100 columns) and ESLint. CI checks both.

## 5. Common tasks

| Change                          | Where                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a setting                   | `loadConfig()` in `src/config.mjs` (default + validation), `.env.example`, the README table. Test: `tests/unit/config.test.mjs`                             |
| Change a check's report         | `checkOutput()` in `src/reporting.mjs`. Test: `tests/unit/reporting.test.mjs`                                                                               |
| Copy another app setting        | Add the key to `BUILD_KEYS` (saved with `saveBuildType`) or `UPDATE_KEYS` (saved with `update`) in `src/defaults.mjs`. Test: `tests/unit/defaults.test.mjs` |
| Support a new Dokploy API shape | `tick()` in `src/index.mjs` for app listing; `util.mjs` for parsing. Keep the old shape working too.                                                        |
| Change cleanup                  | `src/cleanup.mjs`. Test: `tests/unit/cleanup.test.mjs`                                                                                                      |

### Endpoints used

| Dokploy                          | For                                 |
| -------------------------------- | ----------------------------------- |
| `GET project.all`                | Listing apps                        |
| `GET application.one`            | The full app                        |
| `GET previewDeployment.all`      | An app's previews                   |
| `GET github.one`                 | The GitHub App's credentials        |
| `POST application.saveBuildType` | Defaults: build settings            |
| `POST application.update`        | Defaults, preview port, preview env |

| GitHub                                                        | For                                   | Permission                    |
| ------------------------------------------------------------- | ------------------------------------- | ----------------------------- |
| `POST/GET/DELETE /repos/{r}/deployments`, `POST …/statuses`   | Deployments, cleanup                  | Deployments: write            |
| `POST/PATCH /repos/{r}/check-runs`                            | Checks                                | Checks: write                 |
| `POST /repos/{r}/statuses/{sha}`                              | Fallback without checks               | Commit statuses: write        |
| `GET /repos/{r}/commits/{branch}`, `GET /repos/{r}/pulls/{n}` | The commit being built                | Contents, Pull requests: read |
| `DELETE /repos/{r}/environments/{name}`                       | Removing an empty preview environment | Administration: write         |

## 6. Commands

| Command                        | What it does                                 |
| ------------------------------ | -------------------------------------------- |
| `pnpm test`                    | Every test (no services needed)              |
| `pnpm lint` / `pnpm format`    | ESLint / Prettier (`format:check` in CI)     |
| `node scripts/check-links.mjs` | Relative links in the Markdown files resolve |
| `pnpm start`                   | Run the bridge with the current environment  |

**Against a real Dokploy, safely:**

```bash
DOKPLOY_API_KEY=… DOKPLOY_URL=https://dokploy.example.com DATA_DIR=./data-dev \
DRY_RUN=true ONCE=true LOG_LEVEL=debug pnpm start
```

- `ONCE` runs one tick and exits.
- `DRY_RUN` logs writes instead of sending them; reads still go through.
- Use a throwaway `DATA_DIR`, because a dry run's state marks deployments as already reported.

## 7. Testing and CI

All tests are in `tests/`, found by the glob `tests/**/*.test.mjs`, and run with Node's built-in `node:test`. Layout and helpers are in [tests/README.md](tests/README.md).

CI is `.github/workflows/ci.yml`, on pull requests and pushes to `main`:

- `static`: Prettier, ESLint, links, and a guard that fails on a test file outside `tests/`
- `unit`: `pnpm test`
- `build`: the Docker image
- `required`: fails unless every other job succeeded

**`required` is the only check branch protection needs.** Never make CI green by weakening a test.

### Pull requests

Never push to `main`; open a pull request.

1. Before pushing, run `pnpm format:check && pnpm lint && pnpm test`.
2. After pushing, wait for the checks (`gh pr checks <number> --watch`), and fix failures from their logs (`gh run view <run-id> --log-failed`).
3. Merge only when `required` is green.

## 8. Deployment

- **`Dockerfile`:** `node:24-alpine` with `package.json` and `src/`. It declares `VOLUME /data` and a `HEALTHCHECK` (`src/healthcheck.mjs`). It runs as root, only so it can read Dokploy's root-owned build logs.
- **`docker-compose.yml`:** builds the image and joins the external `dokploy-network`, with a named volume for `/data` and Dokploy's logs mounted read-only.
- The bridge can also run as a Dokploy app (see the README). Its preview deployments must stay off, because **two bridges must never run at once**.

## 9. Key decisions

- **Polling, not webhooks.** Dokploy has no outgoing webhooks for deploy status, and polling needs no inbound port or per-repo setup. 10 seconds is fast enough for a check to feel live.
- **Dokploy's GitHub App, not a new one.** It's already installed on the right repositories with the right access, so there's nothing for the user to create.
- **Baseline on first run.** Reporting history would flood GitHub and might post checks on old commits; only new work is reported.
- **Delete closed previews instead of only marking them inactive.** Inactive deployments still crowd the Deployments sidebar, and closing a PR should leave no trace there.

## Known limitations

- GitHub only, and Dokploy **applications** only: Docker Compose services aren't handled.
- Dokploy's API isn't a stable public API, so field names can change between Dokploy versions.
- Build-log tails need the bridge on the server where builds run.
