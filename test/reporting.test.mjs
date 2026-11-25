import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { report, markBuilding, settleStale, checkOutput, logTail, PENDING_TIMEOUT_MS } from '../src/reporting.mjs';
import { ctxWith, fakeGitHub, testConfig, app, SHA } from './helpers.mjs';

const dep = (over = {}) => ({ deploymentId: 'd1', status: 'done', description: `Commit: ${SHA}`,
  startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:30Z', ...over });
const opts = { environment: 'Production', transient: false, url: 'https://shortless.example.com', checkName: 'Dokploy' };

test('a finished deployment becomes a GitHub deployment (success) and a completed check', async () => {
  const { gh, db } = fakeGitHub();
  const ctx = ctxWith({ gh });
  const id = await report(ctx, app(), dep(), opts);
  assert.equal(db.deployments.length, 1);
  assert.equal(db.deployments[0].id, id);
  assert.deepEqual(db.deployments[0].statuses, ['success']);
  assert.equal(db.checks.length, 1);
  assert.equal(db.checks[0].conclusion, 'success');
  assert.equal(db.checks[0].output.title, 'Deployed to shortless.example.com');
  assert.match(db.checks[0].output.summary, /took 1m 30s/);
  // Reporting the same status again is a no-op.
  const before = db.calls.length;
  await report(ctx, app(), dep(), opts);
  assert.equal(db.calls.length, before);
});

test('running then done updates the same deployment and check', async () => {
  const { gh, db } = fakeGitHub();
  const ctx = ctxWith({ gh });
  await report(ctx, app(), dep({ status: 'running', finishedAt: undefined }), opts);
  await report(ctx, app(), dep({ status: 'error', errorMessage: 'npm ERR! build failed' }), opts);
  assert.equal(db.deployments.length, 1);
  assert.deepEqual(db.deployments[0].statuses, ['in_progress', 'failure']);
  assert.equal(db.checks.length, 1);
  assert.equal(db.checks[0].status, 'completed');
  assert.equal(db.checks[0].conclusion, 'failure');
  assert.match(db.checks[0].output.title, /^Failed: npm ERR! build failed/);
});

test('deployments without a commit (manual deploys) are skipped with one log line', async () => {
  const { gh, db } = fakeGitHub();
  const ctx = ctxWith({ gh });
  assert.equal(await report(ctx, app(), dep({ description: 'Manual deployment' }), opts), null);
  await report(ctx, app(), dep({ description: 'Manual deployment' }), opts);
  assert.equal(db.calls.length, 0);
  assert.equal(ctx.log.lines.filter((l) => l.includes('not reporting')).length, 1);
});

test('falls back to commit statuses when the app lacks the Checks permission', async () => {
  const { gh, db } = fakeGitHub({ forbid: [['POST', /check-runs$/]] });
  const ctx = ctxWith({ gh });
  await report(ctx, app(), dep(), opts);
  assert.equal(ctx.flags.checksUnavailable, true);
  assert.equal(db.statuses.length, 1);
  assert.equal(db.statuses[0].state, 'success');
  assert.equal(db.statuses[0].context, 'Dokploy');
});

test('GITHUB_DEPLOYMENTS=false posts only the check', async () => {
  const { gh, db } = fakeGitHub();
  const ctx = ctxWith({ gh, cfg: testConfig({ GITHUB_DEPLOYMENTS: 'false' }) });
  await report(ctx, app(), dep(), opts);
  assert.equal(db.deployments.length, 0);
  assert.equal(db.checks.length, 1);
});

test('in-progress check before Dokploy writes a record is adopted by report()', async () => {
  const { gh, db } = fakeGitHub();
  const ctx = ctxWith({ gh });
  const pend = await markBuilding(ctx, app(), { key: 'app1|prod', sha: SHA, ...opts });
  assert.ok(pend.gh && pend.check);
  await report(ctx, app(), dep(), opts);
  assert.equal(db.deployments.length, 1, 'no second deployment');
  assert.equal(db.checks.length, 1, 'no second check');
  assert.equal(db.checks[0].conclusion, 'success');
  assert.deepEqual(ctx.store.state.pending, {});
});

test('a pending check is closed after the build stops without a record', async () => {
  const { gh, db } = fakeGitHub();
  const ctx = ctxWith({ gh });
  await markBuilding(ctx, app(), { key: 'k', sha: SHA, ...opts });
  const t0 = Date.now();
  await settleStale(ctx, app(), 'k', false, false, t0);
  assert.ok(ctx.store.state.pending.k, 'waits first');
  await settleStale(ctx, app(), 'k', false, false, t0 + PENDING_TIMEOUT_MS + 1);
  assert.equal(ctx.store.state.pending.k, undefined);
  assert.equal(db.checks[0].conclusion, 'neutral');
  assert.deepEqual(db.deployments[0].statuses, ['in_progress', 'inactive']);
});

test('check output masks env values in the build log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  const logPath = path.join(dir, 'build.log');
  fs.writeFileSync(logPath, 'step 1\nusing key s3cr3t-value-xyz\n\x1b[31mERROR boom\x1b[0m\n');
  const a = app({ env: 'API_KEY=s3cr3t-value-xyz' });
  const out = checkOutput(testConfig(), a, dep({ status: 'error', logPath }), { url: undefined, environment: 'Production' });
  assert.match(out.text, /using key \*\*\*/);
  assert.doesNotMatch(out.text, /s3cr3t/);
  assert.match(out.text, /ERROR boom/);
  assert.equal(logTail(a, { logPath }, 1), 'ERROR boom');
  assert.match(logTail(a, { logPath: path.join(dir, 'missing.log') }, 5), /not readable/);
});
