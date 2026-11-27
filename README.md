# dokploy-bridge

Vercel-style GitHub integration for a self-hosted [Dokploy](https://dokploy.com). Every push and pull request gets a deployment in GitHub's Deployments view and a ✅ or ❌ check with a build report, and previews clean themselves up when the PR closes. A small companion container that you run next to Dokploy, with nothing to set up per repository.

## Features

- **Checks on every commit.** A check named `Dokploy` (production) or `Dokploy Preview` (pull requests) spins while Dokploy builds. It then ends ✅ with the live URL and build time, or ❌ with the error and the last lines of the build log, with the app's secrets masked.
- **GitHub Deployments.** Each deploy shows up as `Production` or `Preview (PR #n)` in the repository's Deployments sidebar, with a **View deployment** button on the pull request.
- **Previews that clean up.** When a pull request is closed or merged and Dokploy removes its preview, the preview's GitHub deployments and environment are deleted. The Deployments view only lists what's live.
- **Settings for new apps.** Apps you create can start with rollbacks, your build type and your preview settings (wildcard domain, HTTPS, certificate, limit, collaborators only), set once from `NEW_APP_*` variables. For apps from GitHub, the preview port follows the app's first domain, and previews use the production environment variables until you set your own.
- **Domains that just work.** A domain you add can get HTTPS, your certificate setting and the port from the app's Dockerfile `EXPOSE`, set once from `NEW_DOMAIN_*` variables, so you only type the host.
- **Uptime monitors.** With [Uptime Kuma](https://github.com/louislam/uptime-kuma) 1.23, a domain you add gets a monitor once the app has deployed. Removing the domain or the app deletes the monitor. Preview domains get none. See [Uptime monitors](#uptime-monitors).
- **Leaves what exists alone.** On its first run the bridge only records the apps and deployments already there; it doesn't change or report them.

## Self-hosting

You need a Dokploy server whose apps deploy from the **GitHub** provider (Git URLs, GitLab, Bitbucket and Gitea aren't supported), and Docker on that server. The bridge talks to Dokploy's API over Dokploy's Docker network, and to GitHub as the GitHub App Dokploy already uses. It needs no webhooks, no ports and no app of its own.

### Quick start

On the Dokploy server:

```bash
git clone https://github.com/prabhask5/dokploy-bridge.git && cd dokploy-bridge
cp .env.example .env
nano .env                  # set DOKPLOY_API_KEY, and ideally DOKPLOY_PUBLIC_URL
docker compose up -d --build
docker compose logs -f     # "dokploy-bridge 0.3.0 starting", then "baseline: N existing app(s)"
```

Then push a commit to any app's repository, and its check appears on GitHub within a few seconds.

`DOKPLOY_API_KEY` must belong to a Dokploy **owner or admin** (_Settings → Profile → API/CLI_). Only they can read the GitHub App's private key, which the bridge needs to act as that app.

### Running it inside Dokploy

The bridge can also be deployed as a Dokploy app itself:

1. **Create an application** from this repository, with the **Dockerfile** build type.
2. **Environment:** the variables from [`.env.example`](.env.example).
3. **Advanced → Volumes:**
   - a bind mount from a host folder (e.g. `/opt/dokploy-bridge/data`) to `/data`
   - optionally `/etc/dokploy/logs` to `/etc/dokploy/logs`, for build logs in checks
4. **Turn Preview Deployments off** for this app. A preview would start a second bridge, and every check and deployment would be reported twice.
5. **Deploy.** Dokploy apps join `dokploy-network`, so the default `DOKPLOY_URL` works.

**Only ever run one bridge** per Dokploy server.

### GitHub permissions

The bridge uses the GitHub App that Dokploy created when you connected GitHub. In _GitHub → Settings → Developer settings → GitHub Apps → (your Dokploy app) → Permissions_, give it:

| Repository permission   | Access         | Used for                                                                     |
| ----------------------- | -------------- | ---------------------------------------------------------------------------- |
| Checks                  | Read and write | Check runs. Without it the bridge falls back to plain commit statuses.       |
| Deployments             | Read and write | The Deployments view, and deleting closed PRs' deployments                   |
| Commit statuses         | Read and write | The fallback when Checks is missing                                          |
| Contents, Pull requests | Read           | Finding the commit being built (Dokploy's app usually already has these)     |
| Administration          | Read and write | Optional. Deleting the empty `Preview (PR #n)` environment after a PR closes |

After changing permissions, GitHub asks you to **accept them** on each installation (_Settings → Applications → Installed GitHub Apps → Configure_).

### Environment variables

Only `DOKPLOY_API_KEY` is required. All of them are listed with their defaults in [`.env.example`](.env.example).

| Variable                                                                                                                                                                                                                        | Purpose                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOKPLOY_API_KEY`                                                                                                                                                                                                               | An owner or admin API key. Required.                                                                                                             |
| `DOKPLOY_PUBLIC_URL`                                                                                                                                                                                                            | Your dashboard's public address, for "Open in Dokploy" links on GitHub.                                                                          |
| `DOKPLOY_URL`                                                                                                                                                                                                                   | Where the bridge reaches Dokploy's API. Default `http://dokploy:3000`.                                                                           |
| `POLL_SECONDS`                                                                                                                                                                                                                  | How often to check Dokploy. Default `10`.                                                                                                        |
| `IGNORE_APPS`                                                                                                                                                                                                                   | Comma-separated apps to leave alone. An app can also opt out with `dokploy-bridge: off` in its description.                                      |
| `PREVIEW_PORT_SYNC`, `PREVIEW_ENV_INHERIT`                                                                                                                                                                                      | Turn the preview follow-ups for new apps off.                                                                                                    |
| `NEW_APP_ROLLBACK_REGISTRY`                                                                                                                                                                                                     | Turn rollbacks on for new apps, using this registry (its name or ID in Dokploy).                                                                 |
| `NEW_APP_BUILD_TYPE`                                                                                                                                                                                                            | Build type for new apps, such as `dockerfile`. Only replaces Dokploy\'s default (Nixpacks), never a type you picked.                             |
| `NEW_APP_PREVIEWS`, `NEW_APP_PREVIEW_WILDCARD`, `NEW_APP_PREVIEW_HTTPS`, `NEW_APP_PREVIEW_CERTIFICATE`, `NEW_APP_PREVIEW_LIMIT`, `NEW_APP_PREVIEW_COLLABORATORS_ONLY`                                                           | Preview settings for new apps, applied once they deploy from GitHub. Unset ones keep Dokploy's default.                                          |
| `NEW_DOMAIN_HTTPS`, `NEW_DOMAIN_CERTIFICATE`, `NEW_DOMAIN_PORT_FROM_DOCKERFILE`                                                                                                                                                 | Settings for domains added from now on, applied once. The port is read from the Dockerfile's last `EXPOSE` (Dockerfile builds from GitHub only). |
| `KUMA_URL`, `KUMA_USERNAME`, `KUMA_PASSWORD`                                                                                                                                                                                    | Turn uptime monitors on. The user must not have 2FA on.                                                                                          |
| `KUMA_MONITOR_INTERVAL`, `KUMA_MONITOR_RETRIES`, `KUMA_MONITOR_RETRY_INTERVAL`, `KUMA_MONITOR_TIMEOUT`, `KUMA_MONITOR_RESEND`, `KUMA_MONITOR_EXPIRY_NOTIFICATION`, `KUMA_MONITOR_MAX_REDIRECTS`, `KUMA_MONITOR_ACCEPTED_STATUS` | Settings for new monitors. Defaults `60`, `2`, `20`, `48`, `0`, `true`, `10`, `200-299`.                                                         |
| `KUMA_MONITOR_NOTIFICATIONS`                                                                                                                                                                                                    | Comma-separated notification names. Default: the ones marked default in Kuma.                                                                    |
| `KUMA_MAX_DELETES_PER_TICK`                                                                                                                                                                                                     | Refuse to delete more monitors than this at once. Default `3`.                                                                                   |
| `GITHUB_DEPLOYMENTS`, `GITHUB_CHECKS`                                                                                                                                                                                           | Turn deployments or checks off. Without checks, the bridge uses commit statuses.                                                                 |
| `PREVIEW_CLEANUP`, `DELETE_PREVIEW_ENVIRONMENTS`                                                                                                                                                                                | Turn cleanup off, or keep the empty environment (if you don't grant Administration).                                                             |
| `CHECK_NAME_PRODUCTION`, `CHECK_NAME_PREVIEW`                                                                                                                                                                                   | The check names. Default `Dokploy` and `Dokploy Preview`.                                                                                        |
| `ENVIRONMENT_PRODUCTION`, `ENVIRONMENT_PREVIEW`                                                                                                                                                                                 | The GitHub environment names. The preview one must contain `{pr}`.                                                                               |
| `LOG_TAIL_LINES_SUCCESS`, `LOG_TAIL_LINES_FAILURE`                                                                                                                                                                              | Lines of the build log in a check. `0` for none.                                                                                                 |
| `DRY_RUN`                                                                                                                                                                                                                       | `true` logs every change instead of making it.                                                                                                   |
| `LOG_LEVEL`                                                                                                                                                                                                                     | `debug` for more detail.                                                                                                                         |

### Uptime monitors

Uptime Kuma has no API for monitors; the bridge signs in the way Kuma's own web page does. It needs to reach Kuma, for example by connecting Kuma's container to Dokploy's network:

```bash
docker network connect dokploy-network uptime-kuma   # then KUMA_URL=http://uptime-kuma:3001
```

Each app's monitor can be tuned with lines in its Dokploy description:

```
monitor: Stellar Planner    the monitor's name (default: the app's name), or "off" for none
health: /api/health         the path to check (default: the domain's root)
keyword: ok                 makes it a keyword monitor that needs this text in the response
```

- Domains that existed when the feature was turned on are left alone.
- If a monitor for the domain's host already exists, the bridge uses it and never deletes it. Only monitors it created are deleted.
- Monitors aren't added to any status page; that's left to you.

### Updating, starting over, security

- **Updating:** `git pull && docker compose up -d --build`. Keep the `/data` volume, so nothing is reported twice.
- **Trying it first:** `DRY_RUN=true` shows what the bridge would do without changing anything.
- **Starting over:** stop the bridge and delete `state.json` from `/data`. The next start treats everything as already there.
- **Security:** the API key can do anything in Dokploy, and the bridge reads Dokploy's GitHub App key, so don't expose the container. It listens on no port. Check output is public on public repositories: env values are masked, but if your builds print other secrets, set `LOG_TAIL_LINES_*=0`.

### Troubleshooting

| You see                                           | What to do                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cannot reach Dokploy at http://dokploy:3000`     | Run the bridge on `dokploy-network`, or set `DOKPLOY_URL`.                                 |
| `cannot read the GitHub App private key`          | The API key isn't an owner's or admin's.                                                   |
| `403 ... Resource not accessible by integration`  | A permission from the table above is missing, or not yet accepted on the installation.     |
| `not reporting deployment ... no commit`          | A manual deploy or a rollback: there's no commit to put a check on. Nothing to fix.        |
| `build log not readable` in a check               | Mount `/etc/dokploy/logs` into the container at the same path.                             |
| `environment kept (no Administration permission)` | Grant Administration, or set `DELETE_PREVIEW_ENVIRONMENTS=false` to keep the environments. |
| `cannot reach Uptime Kuma`                        | Connect Kuma's container to `dokploy-network`, or fix `KUMA_URL`.                          |

## Development

Prerequisites: Node 22.18 or newer (with Corepack, which provides pnpm).

```bash
corepack enable
pnpm install
pnpm test                  # every test, no services needed
pnpm lint && pnpm format:check
```

How the tests are organised: [tests/README.md](tests/README.md). Architecture, state and conventions: [CLAUDE.md](CLAUDE.md).

## Project structure

```
src/         the bridge: main loop, Dokploy, GitHub and Uptime Kuma clients, the features
tests/       every test: unit, end to end against fake Dokploy and GitHub servers
scripts/     check-links.mjs, run in CI
```

## License

[MIT](LICENSE) © 2026 Walter Mac
