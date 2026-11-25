// One app, one pass: report production and preview deployments to GitHub, then clean up previews.
import { shaOf, hasGithubSource, prodUrl, previewUrl, previewEnvName, repoOf } from "./util.mjs";
import { report, markBuilding, settleStale } from "./reporting.mjs";
import { retireRemovedPreviews, sweepOrphans } from "./cleanup.mjs";

// On the bridge's very first run (baseline) existing deployments are recorded as already reported,
// so it doesn't flood GitHub with history.
function recordBaseline(state, dep) {
  state.reported[dep.deploymentId] = { status: dep.status, skipped: true };
}

export async function syncApp(ctx, a, baseline) {
  const { cfg, log, dk, gh, store } = ctx;
  if (!hasGithubSource(a)) return;
  if (!cfg.githubDeployments && !cfg.githubChecks && !cfg.previewCleanup) return;
  const { state } = store;
  const repo = repoOf(a);
  const reporting = cfg.githubDeployments || cfg.githubChecks;

  // Production
  if (reporting) {
    const key = `${a.applicationId}|prod`;
    const opts = {
      environment: cfg.environmentProduction,
      transient: false,
      url: prodUrl(a),
      checkName: cfg.checkNameProduction,
    };
    const runningRecord = (a.deployments || []).some((d) => d.status === "running" && shaOf(d));
    if (!baseline && a.applicationStatus === "running" && !runningRecord) {
      try {
        const head = (
          await gh(
            a.githubId,
            "GET",
            `/repos/${repo}/commits/${encodeURIComponent(a.branch || "HEAD")}`,
          )
        ).sha;
        const finished = (a.deployments || []).some(
          (d) => shaOf(d) === head && d.status !== "running",
        );
        if (!finished) await markBuilding(ctx, a, { key, sha: head, ...opts });
      } catch (e) {
        log.info(`[${a.name}] in-progress check: ${e.message}`);
      }
    }
    for (const dep of a.deployments || []) {
      if (baseline && !state.reported[dep.deploymentId] && dep.status !== "running") {
        recordBaseline(state, dep);
        continue;
      }
      await report(ctx, a, dep, opts);
    }
    await settleStale(
      ctx,
      a,
      key,
      a.applicationStatus === "running",
      a.applicationStatus === "error",
    );
  }

  // Previews
  const previews =
    (await dk("GET", `previewDeployment.all?applicationId=${a.applicationId}`)) || [];
  const liveIds = new Set(),
    liveEnvs = new Set();
  for (const p of previews) {
    const environment = previewEnvName(cfg.environmentPreview, p.pullRequestNumber);
    liveIds.add(p.previewDeploymentId);
    liveEnvs.add(environment);
    const rec = (state.previews[p.previewDeploymentId] ||= { repo, githubId: a.githubId, gh: [] });
    rec.environment = environment;
    if (!reporting) continue;
    const key = `${a.applicationId}|pr${p.pullRequestNumber}`;
    const opts = {
      environment,
      transient: true,
      url: previewUrl(p),
      checkName: cfg.checkNamePreview,
    };
    const runningRecord = (p.deployments || []).some((d) => d.status === "running" && shaOf(d));
    if (!baseline && p.previewStatus === "running" && !runningRecord) {
      try {
        const head = (await gh(a.githubId, "GET", `/repos/${repo}/pulls/${p.pullRequestNumber}`))
          .head.sha;
        const finished = (p.deployments || []).some(
          (d) => shaOf(d) === head && d.status !== "running",
        );
        if (!finished) {
          const pend = await markBuilding(ctx, a, { key, sha: head, ...opts });
          if (pend?.gh && !rec.gh.includes(pend.gh)) {
            rec.gh.push(pend.gh);
            store.save();
          }
        }
      } catch (e) {
        log.info(`[${a.name}] in-progress check: ${e.message}`);
      }
    }
    await settleStale(ctx, a, key, p.previewStatus === "running", p.previewStatus === "error");
    for (const dep of p.deployments || []) {
      if (baseline && !state.reported[dep.deploymentId] && dep.status !== "running") {
        recordBaseline(state, dep);
        continue;
      }
      const id = await report(ctx, a, dep, opts);
      if (id && !rec.gh.includes(id)) {
        rec.gh.push(id);
        store.save();
      }
    }
  }

  // Cleanup of closed PRs
  if (cfg.previewCleanup) {
    await retireRemovedPreviews(ctx, a, liveIds);
    await sweepOrphans(ctx, a, liveEnvs);
  } else {
    for (const [pdId, rec] of Object.entries(state.previews)) {
      if (rec.repo === repo && !liveIds.has(pdId)) {
        delete state.previews[pdId];
        store.save();
      }
    }
  }
}
