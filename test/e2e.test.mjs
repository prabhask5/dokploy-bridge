// End to end: the real HTTP clients (API key header, GitHub App JWT -> installation token) against
// a local fake Dokploy + GitHub server, running whole ticks of the main loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createContext, tick } from '../src/index.mjs';
import { recordingLog } from './helpers.mjs';

const SHA = '1234567abcdef1234567abcdef1234567abcdef1';

test('two ticks: baseline, then a new production deploy is reported through real HTTP', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const seen = [];
  const created = [];
  let deployments = [{ deploymentId: 'old', status: 'done', description: `Commit: ${'0'.repeat(40)}` }];

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}`);
    if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/v3/')) {
      if (req.headers['x-api-key'] !== 'secret-key') return send(401, { message: 'no' });
      const ep = url.pathname.slice(5);
      if (ep === 'project.all') return send(200, [{ environments: [{ applications: [{ applicationId: 'a1', name: 'web', appName: 'web-1' }] }] }]);
      if (ep === 'application.one') {
        return send(200, { applicationId: 'a1', name: 'web', appName: 'web-1', sourceType: 'github', githubId: 'g1', owner: 'me',
          repository: 'web', branch: 'main', applicationStatus: 'done', domains: [{ host: 'web.example.com', https: true }], deployments });
      }
      if (ep === 'previewDeployment.all') return send(200, []);
      if (ep === 'github.one') {
        return send(200, { githubAppId: 42, githubInstallationId: 7, githubPrivateKey: pem, githubUrl: `http://127.0.0.1:${server.address().port}` });
      }
      return send(404, { message: ep });
    }
    // GitHub Enterprise-style API at /api/v3
    const gh = url.pathname.replace(/^\/api\/v3/, '');
    if (gh === '/app/installations/7/access_tokens') {
      const [h, c, s] = req.headers.authorization.replace('Bearer ', '').split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), 'JWT signed with the app key');
      assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, '42');
      return send(201, { token: 'inst-token' });
    }
    assert.equal(req.headers.authorization, 'Bearer inst-token');
    if (req.method === 'POST' && gh === '/repos/me/web/deployments') { created.push(JSON.parse(body)); return send(201, { id: 900 }); }
    if (req.method === 'POST' && gh === '/repos/me/web/deployments/900/statuses') return send(201, {});
    if (req.method === 'POST' && gh === '/repos/me/web/check-runs') return send(201, { id: 901 });
    if (req.method === 'GET' && gh.startsWith('/repos/me/web/deployments')) return send(200, []);
    return send(404, { message: `unhandled ${req.method} ${gh}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
  const { cfg, errors } = loadConfig({ DOKPLOY_API_KEY: 'secret-key', DOKPLOY_URL: base, DATA_DIR: dir, HEARTBEAT_FILE: path.join(dir, 'hb') });
  assert.deepEqual(errors, []);
  const log = recordingLog();
  const ctx = createContext(cfg, { log });
  try {
    await tick(ctx); // baseline: nothing reported
    assert.equal(created.length, 0);
    assert.ok(log.lines.some((l) => l.includes('baseline: 1 existing app')));
    assert.ok(fs.existsSync(path.join(dir, 'hb')));

    deployments = [...deployments, { deploymentId: 'new', status: 'done', description: `Commit: ${SHA}` }];
    await tick(ctx);
    assert.equal(created.length, 1);
    assert.equal(created[0].environment, 'Production');
    assert.equal(created[0].ref, SHA);
    assert.ok(seen.includes('POST /api/v3/repos/me/web/check-runs'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.reported.new.status, 'done');
    assert.equal(state.reported.old.skipped, true);
  } finally {
    server.close();
  }
});
