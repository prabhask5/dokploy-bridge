import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retirePreviewEnv, retireRemovedPreviews, sweepOrphans } from '../src/cleanup.mjs';
import { syncApp } from '../src/sync.mjs';
import { ctxWith, fakeGitHub, testConfig, memoryStore, app, SHA } from './helpers.mjs';

const REPO = 'me/shortless';
async function seed(gh, env, n) {
  for (let i = 0; i < n; i++) await gh('g', 'POST', `/repos/${REPO}/deployments`, { environment: env, ref: SHA });
}

test('retirePreviewEnv deletes every deployment in the environment, then the environment', async () => {
  const { gh, db } = fakeGitHub();
  await seed(gh, 'Preview (PR #1)', 150); // more than one page
  await seed(gh, 'Production', 2);
  const ctx = ctxWith({ gh });
  await retirePreviewEnv(ctx, app(), 'g', REPO, 'Preview (PR #1)');
  assert.equal(db.deployments.filter((d) => d.environment === 'Preview (PR #1)').length, 0);
  assert.equal(db.deployments.filter((d) => d.environment === 'Production').length, 2, 'production untouched');
  assert.ok(!db.envs.has(`${REPO}|Preview (PR #1)`));
  assert.match(ctx.log.lines.at(-1), /150 GitHub deployment\(s\) deleted, environment deleted/);
});

test('without the Administration permission the environment is kept and that is logged once', async () => {
  const { gh, db } = fakeGitHub({ forbid: [['DELETE', /\/environments\//]] });
  await seed(gh, 'Preview (PR #1)', 1);
  await seed(gh, 'Preview (PR #2)', 1);
  const ctx = ctxWith({ gh });
  await retirePreviewEnv(ctx, app(), 'g', REPO, 'Preview (PR #1)');
  await retirePreviewEnv(ctx, app(), 'g', REPO, 'Preview (PR #2)');
  assert.equal(db.deployments.length, 0);
  assert.equal(ctx.log.lines.filter((l) => l.includes('Administration: Read and write')).length, 1);
});

test('DELETE_PREVIEW_ENVIRONMENTS=false only deletes the deployments', async () => {
  const { gh, db } = fakeGitHub();
  await seed(gh, 'Preview (PR #3)', 2);
  const ctx = ctxWith({ gh, cfg: testConfig({ DELETE_PREVIEW_ENVIRONMENTS: 'false' }) });
  await retirePreviewEnv(ctx, app(), 'g', REPO, 'Preview (PR #3)');
  assert.equal(db.deployments.length, 0);
  assert.ok(db.envs.has(`${REPO}|Preview (PR #3)`));
  assert.ok(!db.calls.some((c) => c.startsWith('DELETE') && c.includes('/environments/')));
});

test('retireRemovedPreviews cleans up only previews Dokploy no longer lists', async () => {
  const { gh, db } = fakeGitHub();
  await seed(gh, 'Preview (PR #1)', 1);
  await seed(gh, 'Preview (PR #2)', 1);
  const store = memoryStore({ previews: {
    gone: { repo: REPO, githubId: 'g', environment: 'Preview (PR #1)', gh: [100] },
    live: { repo: REPO, githubId: 'g', environment: 'Preview (PR #2)', gh: [101] },
    other: { repo: 'me/other', githubId: 'g', environment: 'Preview (PR #1)', gh: [] },
  } });
  const ctx = ctxWith({ gh, store });
  await retireRemovedPreviews(ctx, app(), new Set(['live']));
  assert.deepEqual(Object.keys(store.state.previews).sort(), ['live', 'other']);
  assert.deepEqual(db.deployments.map((d) => d.environment), ['Preview (PR #2)']);
});

test('sweepOrphans removes leftover preview environments once per repo, keeping live ones', async () => {
  const { gh, db } = fakeGitHub();
  await seed(gh, 'Preview (PR #1)', 2);
  await seed(gh, 'Preview (PR #4)', 1);
  await seed(gh, 'Production', 1);
  await seed(gh, 'staging', 1);
  const ctx = ctxWith({ gh });
  await sweepOrphans(ctx, app(), new Set(['Preview (PR #4)']));
  assert.deepEqual(db.deployments.map((d) => d.environment).sort(), ['Preview (PR #4)', 'Production', 'staging']);
  const calls = db.calls.length;
  await sweepOrphans(ctx, app(), new Set());
  assert.equal(db.calls.length, calls, 'second sweep is a no-op');
});

test('syncApp end to end: preview reported, then cleaned up when Dokploy removes it', async () => {
  const { gh, db } = fakeGitHub();
  const store = memoryStore();
  let previews = [{ previewDeploymentId: 'pd1', pullRequestNumber: 7, previewStatus: 'done', domain: { host: 'pr7.example.com' },
    deployments: [{ deploymentId: 'pdep1', status: 'done', description: `Commit: ${SHA}` }] }];
  const dk = async (method, p) => (p.startsWith('previewDeployment.all') ? previews : null);
  const ctx = ctxWith({ gh, dk, store });
  await syncApp(ctx, app(), false);
  assert.deepEqual(db.deployments.map((d) => d.environment), ['Preview (PR #7)']);
  assert.equal(db.checks[0].name, 'Dokploy Preview');
  previews = [];
  await syncApp(ctx, app(), false);
  assert.equal(db.deployments.length, 0);
  assert.ok(!db.envs.has(`${REPO}|Preview (PR #7)`));
  assert.deepEqual(store.state.previews, {});
});

test('baseline run records existing deployments without reporting them', async () => {
  const { gh, db } = fakeGitHub();
  const store = memoryStore({ baselined: false });
  const ctx = ctxWith({ gh, store, dk: async () => [] });
  await syncApp(ctx, app({ deployments: [{ deploymentId: 'old', status: 'done', description: `Commit: ${SHA}` }] }), true);
  assert.equal(db.deployments.length, 0);
  assert.equal(store.state.reported.old.skipped, true);
});
