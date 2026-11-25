# Tests

Every test in the repository lives here. CI fails if a `*.test.*` file exists anywhere else.

```
tests/
  support/helpers.mjs   test doubles: fake GitHub, in-memory store, recording log, test config
  unit/                 one file per module in src/, no network
  e2e/                  whole ticks of the main loop, real HTTP clients, fake servers
```

## Running

| Command                                                       | Needs   | What runs                   |
| ------------------------------------------------------------- | ------- | --------------------------- |
| `pnpm test`                                                   | nothing | every `tests/**/*.test.mjs` |
| `node --test tests/unit/cleanup.test.mjs`                     | nothing | one file                    |
| `node --test --test-name-pattern=sweep "tests/**/*.test.mjs"` | nothing | tests whose name matches    |

The runner is Node's built-in `node:test`, so there's nothing to install for it.

- **Unit tests** call one module with a context built by `ctxWith()` from `support/helpers.mjs`. `fakeGitHub()` stores deployments, statuses, check runs and environments in memory, logs every call, and simulates a missing permission with `forbid: [[method, /path regex/]]`. Dokploy is a plain `async (method, path) => …` function.
- **e2e** (`e2e/bridge.test.mjs`) starts one local HTTP server that plays both Dokploy and a GitHub Enterprise API. It runs two real ticks: the baseline run, then a new deployment that must be reported. It checks the API key header and verifies the signature of the GitHub App JWT against a freshly generated key.

## Adding a test

Put it next to the module it covers (`unit/<module>.test.mjs`). Prefer `fakeGitHub()` and assert on its `db` (what GitHub ended up with) rather than on exact call sequences, so refactors don't break tests that still describe the right behaviour.
