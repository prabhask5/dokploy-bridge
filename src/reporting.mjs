// Feature 2: every Dokploy deployment of a commit becomes a GitHub Deployment (the Deployments
// view, "View deployment" on PRs) and a check run (the ✅/❌ on the commit and PR, with a report).
// Falls back to plain commit statuses if the GitHub App lacks the Checks permission.
import fs from 'node:fs';
import { shaOf, fmtDuration, stripAnsi, secretValues, maskSecrets, dashboardUrl, repoOf } from './util.mjs';

const CONCLUSION = { done: 'success', error: 'failure', cancelled: 'cancelled' };
const DEPLOYMENT_STATE = { running: 'in_progress', done: 'success', error: 'failure', cancelled: 'error' };
export const PENDING_TIMEOUT_MS = 120000;

// Last lines of Dokploy's build log, ANSI codes stripped and the app's env values masked
// (check output is public on public repos).
export function logTail(a, dep, lines) {
  if (!dep.logPath || lines <= 0) return '';
  try {
    const fd = fs.openSync(dep.logPath, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const text = maskSecrets(stripAnsi(buf.toString('utf8')), secretValues(a.env || '', a.previewEnv || '', a.buildArgs || ''));
    return text.trimEnd().split('\n').slice(-lines).join('\n').slice(-60000);
  } catch (e) {
    return `(build log not readable by dokploy-bridge: ${e.code || e.message}; mount Dokploy's logs directory read-only)`;
  }
}

export function checkOutput(cfg, a, dep, { url, environment }) {
  const sha = shaOf(dep);
  const dash = dashboardUrl(cfg.dokployPublicUrl, a);
  const dur = fmtDuration(dep.startedAt || dep.createdAt, dep.finishedAt);
  const rows = [
    url ? `| URL | ${url} |` : null,
    `| Environment | ${environment} |`,
    `| Commit | \`${sha.slice(0, 7)}\` |`,
    dur ? `| Build + deploy time | ${dur} |` : null,
    dash ? `| Dokploy | [Open deployment](${dash}) |` : null,
  ].filter(Boolean);
  const table = `| | |\n| --- | --- |\n${rows.join('\n')}`;
  if (dep.status === 'running') {
    return { title: 'Building on Dokploy', summary: `Dokploy is building and deploying \`${sha.slice(0, 7)}\`.\n\n${table}` };
  }
  if (dep.status === 'done') {
    const tail = logTail(a, dep, cfg.logLinesSuccess);
    return {
      title: url ? `Deployed to ${new URL(url).host}` : 'Deployed',
      summary: `${url ? `**Live at ${url}**` : '**Deployed**'}${dur ? ` (took ${dur})` : ''}\n\n${table}`,
      ...(tail ? { text: `<details><summary>End of the build log</summary>\n\n\`\`\`text\n${tail}\n\`\`\`\n</details>` } : {}),
    };
  }
  const tail = logTail(a, dep, cfg.logLinesFailure);
  const err = (dep.errorMessage || '').trim();
  const cancelled = dep.status === 'cancelled';
  return {
    title: cancelled ? 'Deployment cancelled' : `Failed${err ? `: ${err.split('\n')[0].slice(0, 120)}` : ''}`,
    summary: `${cancelled ? '**Deployment was cancelled.**' : '**The build or deploy failed.**'}`
      + `${err ? `\n\n\`\`\`text\n${err.slice(0, 4000)}\n\`\`\`` : ''}\n\n${table}`,
    ...(tail ? { text: `**Last lines of the build log**\n\n\`\`\`text\n${tail}\n\`\`\`` } : {}),
  };
}

const isForbidden = (e) => e?.status === 403;

async function createDeployment(ctx, a, { sha, environment, transient }) {
  return (await ctx.gh(a.githubId, 'POST', `/repos/${repoOf(a)}/deployments`, {
    ref: sha, environment, auto_merge: false, required_contexts: [],
    transient_environment: transient, production_environment: !transient,
    description: `Dokploy: ${a.name}`,
  })).id;
}

// Report one Dokploy deployment. Returns the GitHub deployment id (or null).
export async function report(ctx, a, dep, { environment, transient, url, checkName }) {
  const { cfg, log, gh, store, flags } = ctx;
  const { state } = store;
  const sha = shaOf(dep);
  const r = state.reported[dep.deploymentId] || {};
  if (!sha || !DEPLOYMENT_STATE[dep.status]) {
    if (!r.noted) { // say once why a deployment isn't reported, instead of skipping silently
      log.info(`[${a.name}] not reporting deployment ${dep.deploymentId} (${dep.status}): no commit in "${dep.description || ''}" (manual deploy or rollback?)`);
      state.reported[dep.deploymentId] = { ...r, noted: true }; store.save();
    }
    return null;
  }
  if (r.status === dep.status) return r.gh ?? null;
  const legacyStatus = Boolean(r.status && !r.check); // reported by an older version as a commit status
  const repo = repoOf(a);
  const done = dep.status === 'done';
  const dash = dashboardUrl(cfg.dokployPublicUrl, a);

  // Adopt the in-progress deployment/check posted while Dokploy was building without a record.
  if (!r.gh && !r.check) {
    const key = Object.keys(state.pending).find((k) => state.pending[k].repo === repo
      && state.pending[k].sha === sha && state.pending[k].checkName === checkName);
    if (key) { r.gh = state.pending[key].gh; r.check = state.pending[key].check; delete state.pending[key]; }
  }

  if (cfg.githubDeployments) {
    if (!r.gh) {
      r.gh = await createDeployment(ctx, a, { sha, environment, transient });
      state.reported[dep.deploymentId] = { ...r, repo }; store.save();
    }
    await gh(a.githubId, 'POST', `/repos/${repo}/deployments/${r.gh}/statuses`, {
      state: DEPLOYMENT_STATE[dep.status], auto_inactive: true,
      description: done ? 'Deployed' : dep.status === 'running' ? 'Building on Dokploy' : 'Dokploy build or deploy failed',
      ...(dash ? { log_url: dash } : {}),
      ...(done && url ? { environment_url: url } : {}),
    });
  }

  const output = checkOutput(cfg, a, dep, { url, environment });
  const conclusion = CONCLUSION[dep.status];
  if (cfg.githubChecks && !flags.checksUnavailable) {
    const body = {
      name: checkName, head_sha: sha, external_id: dep.deploymentId,
      ...(dash ? { details_url: dash } : {}),
      ...(dep.startedAt ? { started_at: new Date(dep.startedAt).toISOString() } : {}),
      ...(conclusion
        ? { status: 'completed', conclusion, completed_at: new Date(dep.finishedAt || Date.now()).toISOString() }
        : { status: 'in_progress' }),
      output,
    };
    try {
      if (r.check) await gh(a.githubId, 'PATCH', `/repos/${repo}/check-runs/${r.check}`, body);
      else r.check = (await gh(a.githubId, 'POST', `/repos/${repo}/check-runs`, body)).id;
    } catch (e) {
      if (!isForbidden(e)) throw e;
      flags.checksUnavailable = true;
      log.info('the GitHub App lacks "Checks: Read and write"; using plain commit statuses until the bridge restarts');
    }
  }
  // Plain commit status: when checks are off or unavailable, or to close out a status that an older
  // bridge version left pending on this commit.
  if (!cfg.githubChecks || flags.checksUnavailable || (legacyStatus && conclusion)) {
    await gh(a.githubId, 'POST', `/repos/${repo}/statuses/${sha}`, {
      state: conclusion ? (conclusion === 'success' ? 'success' : 'failure') : 'pending',
      context: checkName, description: output.title.slice(0, 140),
      ...((done && url) || dash ? { target_url: done && url ? url : dash } : {}),
    });
  }

  state.reported[dep.deploymentId] = { ...r, repo, sha, checkName, status: dep.status, at: Date.now() };
  store.save();
  log.info(`[${a.name}] ${environment} ${sha.slice(0, 7)} -> ${dep.status}${conclusion ? ` (${output.title})` : ''}`);
  return r.gh ?? null;
}

// Some Dokploy versions write the deployment record only when the build ends. While the app or
// preview reports "running" with no matching record, post the in-progress check on the commit being
// built; report() adopts it when the record appears, and settleStale() closes it if none appears
// within PENDING_TIMEOUT_MS after the build stops, so a check never spins forever.
export async function markBuilding(ctx, a, { key, environment, transient, checkName, sha }) {
  const { cfg, log, gh, store, flags } = ctx;
  const { state } = store;
  const repo = repoOf(a);
  if (state.pending[key]?.sha === sha) return state.pending[key];
  if (state.pending[key]) await closePending(ctx, a, key, false, 'Superseded by a newer commit');
  if (Object.values(state.reported).some((x) => x.repo === repo && x.sha === sha && x.checkName === checkName)) return null;
  const dash = dashboardUrl(cfg.dokployPublicUrl, a);
  let ghId, check;
  if (cfg.githubDeployments) {
    ghId = await createDeployment(ctx, a, { sha, environment, transient });
    await gh(a.githubId, 'POST', `/repos/${repo}/deployments/${ghId}/statuses`, {
      state: 'in_progress', description: 'Building on Dokploy', ...(dash ? { log_url: dash } : {}),
    });
  }
  if (cfg.githubChecks && !flags.checksUnavailable) {
    try {
      check = (await gh(a.githubId, 'POST', `/repos/${repo}/check-runs`, {
        name: checkName, head_sha: sha, status: 'in_progress', started_at: new Date().toISOString(),
        ...(dash ? { details_url: dash } : {}),
        output: { title: 'Building on Dokploy', summary: `Dokploy is building and deploying \`${sha.slice(0, 7)}\` to ${environment}.` },
      })).id;
    } catch (e) { if (!isForbidden(e)) throw e; flags.checksUnavailable = true; }
  }
  if (!check) {
    await gh(a.githubId, 'POST', `/repos/${repo}/statuses/${sha}`, {
      state: 'pending', context: checkName, description: 'Building on Dokploy', ...(dash ? { target_url: dash } : {}),
    });
  }
  state.pending[key] = { repo, githubId: a.githubId, sha, gh: ghId, check, checkName, environment, at: Date.now() };
  store.save();
  log.info(`[${a.name}] ${environment} ${sha.slice(0, 7)} -> building`);
  return state.pending[key];
}

export async function closePending(ctx, a, key, failed, desc) {
  const { log, gh, store } = ctx;
  const p = store.state.pending[key];
  if (!p) return;
  try {
    if (p.gh) {
      await gh(p.githubId, 'POST', `/repos/${p.repo}/deployments/${p.gh}/statuses`, { state: failed ? 'failure' : 'inactive', description: desc });
    }
    if (p.check) {
      await gh(p.githubId, 'PATCH', `/repos/${p.repo}/check-runs/${p.check}`, {
        status: 'completed', conclusion: failed ? 'failure' : 'neutral', completed_at: new Date().toISOString(),
        output: { title: desc, summary: `${desc}. Open the app in Dokploy to see its logs.` },
      });
    } else {
      await gh(p.githubId, 'POST', `/repos/${p.repo}/statuses/${p.sha}`, { state: failed ? 'failure' : 'error', context: p.checkName, description: desc });
    }
  } catch (e) { log.info(`[${a.name}] closing check for ${p.sha.slice(0, 7)}: ${e.message}`); return; }
  log.info(`[${a.name}] ${p.environment} ${p.sha.slice(0, 7)} -> ${desc}`);
  delete store.state.pending[key]; store.save();
}

export async function settleStale(ctx, a, key, stillBuilding, failed, now = Date.now()) {
  const p = ctx.store.state.pending[key];
  if (!p) return;
  if (stillBuilding) { if (p.stoppedAt) { delete p.stoppedAt; ctx.store.save(); } return; }
  p.stoppedAt ??= now;
  if (now - p.stoppedAt < PENDING_TIMEOUT_MS) return;
  await closePending(ctx, a, key, failed,
    failed ? 'Build failed before Dokploy recorded a deployment' : 'Build ended without a Dokploy deployment record');
}
