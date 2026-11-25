// HTTP clients for the Dokploy API (API key) and the GitHub API (as Dokploy's own GitHub App).
import crypto from 'node:crypto';

const UA = 'dokploy-bridge (+https://github.com/prabhask5/dokploy-bridge)';
const isWrite = (method) => method !== 'GET';

export class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createDokploy({ cfg, log, fetchImpl = fetch }) {
  return async function dk(method, path, body) {
    if (cfg.dryRun && isWrite(method)) { log.info(`[dry-run] Dokploy ${method} ${path} ${body ? JSON.stringify(body) : ''}`); return null; }
    let res;
    try {
      res = await fetchImpl(`${cfg.dokployUrl}/api/${path}`, {
        method,
        headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json', 'user-agent': UA },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`cannot reach Dokploy at ${cfg.dokployUrl} (${e.cause?.code || e.message}); is the bridge on the same Docker network as Dokploy?`);
    }
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (is DOKPLOY_API_KEY valid?)' : '';
      throw new HttpError(`Dokploy ${method} ${path} -> ${res.status} ${text.slice(0, 300)}${hint}`, res.status);
    }
    return text ? JSON.parse(text) : null;
  };
}

const b64url = (b) => Buffer.from(b).toString('base64url');

export function createGitHub({ cfg, log, dk, fetchImpl = fetch }) {
  const tokens = {};    // githubId -> { token, exp, api }
  const providers = {}; // githubId -> Dokploy GitHub provider (app id, installation id, private key)
  let fakeId = 0;

  async function token(githubId) {
    let t = tokens[githubId];
    if (t && Date.now() < t.exp) return t;
    const p = providers[githubId] ||= await dk('GET', `github.one?githubId=${encodeURIComponent(githubId)}`);
    if (!p?.githubPrivateKey) {
      throw new Error('the Dokploy API key cannot read the GitHub App private key: use an API key of an owner or admin');
    }
    const api = cfg.githubApi || (/(^|\.)github\.com$/.test(new URL(p.githubUrl || 'https://github.com').host)
      ? 'https://api.github.com' : `${p.githubUrl.replace(/\/$/, '')}/api/v3`);
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(p.githubAppId) }));
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(p.githubPrivateKey).toString('base64url');
    const r = await fetchImpl(`${api}/app/installations/${p.githubInstallationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${head}.${claims}.${sig}`, accept: 'application/vnd.github+json', 'user-agent': UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new HttpError(`GitHub installation token -> ${r.status} ${(await r.text()).slice(0, 200)}`, r.status);
    t = tokens[githubId] = { token: (await r.json()).token, exp: Date.now() + 50 * 60 * 1000, api };
    return t;
  }

  return async function gh(githubId, method, path, body) {
    if (cfg.dryRun && isWrite(method)) {
      log.info(`[dry-run] GitHub ${method} ${path}`);
      return method === 'DELETE' ? null : { id: --fakeId };
    }
    const t = await token(githubId);
    const res = await fetchImpl(`${t.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${t.token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': UA, 'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 403 && /not accessible by integration/i.test(text)
        ? ' (the GitHub App is missing a permission: see README "GitHub App permissions")' : '';
      throw new HttpError(`GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}${hint}`, res.status);
    }
    return text ? JSON.parse(text) : null;
  };
}
