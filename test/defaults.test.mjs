import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDefaults, applyDefaults } from '../src/defaults.mjs';
import { ctxWith, testConfig, app } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-defaults-'));

test('captures defaults once from the template app, then reads only the file', async () => {
  const dir = tmp();
  const calls = [];
  const template = { applicationId: 't1', name: 'template', buildType: 'dockerfile', dockerfile: 'Dockerfile',
    rollbackActive: true, isPreviewDeploymentsActive: true, previewWildcard: '*.example.com', env: 'SECRET=x' };
  const dk = async (m, p) => { calls.push(p); return template; };
  const ctx = ctxWith({ dk, cfg: testConfig({ DATA_DIR: dir, TEMPLATE_APP: 'template' }) });
  const snap = await loadDefaults(ctx, [{ applicationId: 't1', name: 'template' }]);
  assert.equal(snap.buildType, 'dockerfile');
  assert.equal(snap.previewWildcard, '*.example.com');
  assert.equal(snap.env, undefined, 'never copies env vars');
  assert.ok(fs.existsSync(path.join(dir, 'defaults.json')));
  await loadDefaults(ctx, []); // template gone: still works from the file
  assert.equal(calls.length, 1);
});

test('applyDefaults writes build type and settings to a new app, once', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'defaults.json'), JSON.stringify({ buildType: 'nixpacks', rollbackActive: true, previewPort: 3000 }));
  const writes = [];
  const dk = async (m, p, body) => { writes.push([p, body]); return null; };
  const ctx = ctxWith({ dk, cfg: testConfig({ DATA_DIR: dir }) });
  const s = {};
  await applyDefaults(ctx, app({ env: '', domains: [] }), s, []);
  assert.equal(writes[0][0], 'application.saveBuildType');
  assert.equal(writes[0][1].buildType, 'nixpacks');
  assert.equal(writes[1][0], 'application.update');
  assert.equal(writes[1][1].rollbackActive, true);
  assert.equal(s.defaults, true);
  writes.length = 0;
  await applyDefaults(ctx, app({ env: '', domains: [] }), s, []);
  assert.equal(writes.length, 0, 'not applied twice');
});

test('preview port follows the first domain; previews inherit env until customised', async () => {
  const writes = [];
  const dk = async (m, p, body) => { writes.push(body); return null; };
  const ctx = ctxWith({ dk, cfg: testConfig({ DEFAULTS: 'false' }) });
  const s = { defaults: true };
  const a = app({ previewPort: 80, env: 'A=1', previewEnv: '' });
  await applyDefaults(ctx, a, s, []);
  assert.deepEqual(writes.map((w) => Object.keys(w).filter((k) => k !== 'applicationId')), [['previewPort'], ['previewEnv']]);
  assert.equal(writes[0].previewPort, 3000);
  writes.length = 0;
  // The user customised preview env: leave it alone.
  await applyDefaults(ctx, app({ previewPort: 3000, env: 'A=2', previewEnv: 'A=custom' }), s, []);
  assert.equal(writes.length, 0);
});
