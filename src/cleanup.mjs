// Feature 3: when a PR closes and Dokploy removes its preview, take the preview out of GitHub's
// Deployments view. Every deployment in its environment is marked inactive and deleted (needs
// Deployments: write), then the empty environment is deleted (needs Administration: write; without
// it the bridge says so once and the empty environment stays under Settings -> Environments).
import { previewEnvPattern, repoOf } from './util.mjs';

export async function retirePreviewEnv(ctx, a, ghId, repo, env) {
  const { cfg, log, gh } = ctx;
  let removed = 0;
  for (let round = 0; round < 20; round++) { // re-read page 1 each round: deleting shifts the pages
    const deps = await gh(ghId, 'GET', `/repos/${repo}/deployments?environment=${encodeURIComponent(env)}&per_page=100`);
    if (!deps?.length) break;
    let n = 0;
    for (const d of deps) {
      try {
        await gh(ghId, 'POST', `/repos/${repo}/deployments/${d.id}/statuses`, { state: 'inactive', description: 'Pull request closed; preview removed' });
        await gh(ghId, 'DELETE', `/repos/${repo}/deployments/${d.id}`);
        n++;
      } catch (e) { log.info(`[${a.name}] delete deployment ${d.id}: ${e.message}`); }
    }
    removed += n;
    if (n === 0 || cfg.dryRun) break;
  }
  let note = 'environment kept (DELETE_PREVIEW_ENVIRONMENTS=false)';
  if (cfg.deletePreviewEnvironments) {
    try {
      await gh(ghId, 'DELETE', `/repos/${repo}/environments/${encodeURIComponent(env)}`);
      note = 'environment deleted';
    } catch (e) {
      if (e.status === 404) note = 'environment already gone';
      else if (e.status === 403) {
        note = 'environment kept (no Administration permission)';
        log.once('env-delete-403', 'to also delete empty preview environments, give the GitHub App "Administration: Read and write" '
          + '(repository permissions) and accept the update, or set DELETE_PREVIEW_ENVIRONMENTS=false to silence this');
      } else note = `environment delete failed: ${e.message}`;
    }
  }
  log.info(`[${a.name}] cleaned up ${env}: ${removed} GitHub deployment(s) deleted, ${note}`);
}

// Previews that Dokploy no longer lists (PR closed or merged).
export async function retireRemovedPreviews(ctx, a, liveIds) {
  const { log, gh, store } = ctx;
  const repo = repoOf(a);
  for (const [pdId, rec] of Object.entries(store.state.previews)) {
    if (rec.repo !== repo || liveIds.has(pdId)) continue;
    const ghId = rec.githubId || a.githubId;
    let env = rec.environment;
    if (!env && rec.gh?.length) {
      try { env = (await gh(ghId, 'GET', `/repos/${rec.repo}/deployments/${rec.gh[0]}`)).environment; } catch { /* already gone */ }
    }
    if (env) {
      try { await retirePreviewEnv(ctx, a, ghId, rec.repo, env); } catch (e) {
        log.info(`[${a.name}] cleanup of ${env}: ${e.message}`);
        if ((rec.tries = (rec.tries || 0) + 1) < 5) { store.save(); continue; } // retry next tick, give up after 5
      }
    }
    delete store.state.previews[pdId]; store.save();
  }
}

// Once per repository after each start: preview environments left behind by PRs that closed
// before this cleanup existed, or while the bridge was down.
export async function sweepOrphans(ctx, a, liveEnvs) {
  const { cfg, log, gh, swept } = ctx;
  const repo = repoOf(a);
  if (swept.has(repo)) return;
  swept.add(repo);
  const pattern = previewEnvPattern(cfg.environmentPreview);
  try {
    const envs = new Set();
    for (let page = 1; page <= 10; page++) {
      const deps = await gh(a.githubId, 'GET', `/repos/${repo}/deployments?per_page=100&page=${page}`);
      for (const d of deps || []) if (pattern.test(d.environment)) envs.add(d.environment);
      if (!deps || deps.length < 100) break;
    }
    for (const env of envs) if (!liveEnvs.has(env)) await retirePreviewEnv(ctx, a, a.githubId, repo, env);
  } catch (e) { log.info(`[${a.name}] preview sweep: ${e.message}`); }
}
