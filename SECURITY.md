# Security policy

dokploy-bridge holds powerful credentials: a Dokploy owner/admin API key, and (at runtime) Dokploy's GitHub App private key and installation tokens.

## Reporting a vulnerability
Please **don't open a public issue**. Use [GitHub's private vulnerability reporting](https://github.com/prabhask5/dokploy-bridge/security/advisories/new) instead. I'll reply as soon as I can.

## Supported versions
Only the latest release receives fixes.

## Hardening tips
- Don't publish any port for the bridge container; it only makes outbound requests.
- Keep `.env` readable only by root (`chmod 600`).
- On public repositories, consider `LOG_TAIL_LINES_SUCCESS=0` and `LOG_TAIL_LINES_FAILURE=0` so build logs never appear in checks.
