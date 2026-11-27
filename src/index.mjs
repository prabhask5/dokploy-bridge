#!/usr/bin/env node
// dokploy-bridge: GitHub Deployments + checks, preview cleanup and preview follow-ups for
// every application on a self-hosted Dokploy. See README.md.
import fs from "node:fs";
import { loadConfig } from "./config.mjs";
import { createLog } from "./log.mjs";
import { createStore } from "./store.mjs";
import { createDokploy, createGitHub } from "./clients.mjs";
import { followUpNewApp } from "./previews.mjs";
import { applyNewAppSettings, newAppState } from "./newapps.mjs";
import { syncApp } from "./sync.mjs";
import { isIgnored } from "./util.mjs";
import { hasNewAppSettings } from "./newapps.mjs";
import { hasDomainSettings, syncDomains } from "./domains.mjs";
import { createKuma } from "./kuma.mjs";

export const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export function createContext(cfg, overrides = {}) {
  const log = overrides.log || createLog({ debug: cfg.debug });
  const store = overrides.store || createStore(cfg.stateFile);
  const dk = overrides.dk || createDokploy({ cfg, log });
  const gh = overrides.gh || createGitHub({ cfg, log, dk });
  const kuma = overrides.kuma || (cfg.kuma.url ? createKuma({ cfg, log }) : null);
  return { cfg, log, store, dk, gh, kuma, flags: { checksUnavailable: false }, swept: new Set() };
}

export async function tick(ctx) {
  const { cfg, log, dk, store } = ctx;
  const { state } = store;
  const projects = (await dk("GET", "project.all")) || [];
  // Newer Dokploy versions nest applications under environments; older ones list them on the project.
  const byId = new Map();
  for (const p of projects) {
    for (const app of [
      ...(p.applications || []),
      ...(p.environments || []).flatMap((e) => e.applications || []),
    ]) {
      if (app?.applicationId && !byId.has(app.applicationId)) byId.set(app.applicationId, app);
    }
  }
  const appsList = [...byId.values()];
  const firstRun = !state.baselined;
  const fetched = new Map();
  for (const brief of appsList) {
    if (isIgnored(brief, cfg.ignoreApps)) {
      log.debug(`[${brief.name}] ignored`);
      continue;
    }
    const fresh = !state.apps[brief.applicationId];
    const s = (state.apps[brief.applicationId] ||= { baseline: firstRun });
    s.newApp ??= newAppState(fresh && !firstRun);
    s.newApp.build ??= "n/a"; // apps with state from before NEW_APP_BUILD_TYPE existed
    try {
      const a = await dk("GET", `application.one?applicationId=${brief.applicationId}`);
      if (isIgnored(a, cfg.ignoreApps)) continue;
      fetched.set(a.applicationId, a);
      if (!s.baseline) {
        await applyNewAppSettings(ctx, a, s);
        await followUpNewApp(ctx, a, s);
      }
      await syncApp(ctx, a, firstRun);
    } catch (e) {
      log.info(`[${brief.name}] ${e.message}`);
    }
  }
  try {
    await syncDomains(ctx, fetched, new Set(byId.keys()));
  } catch (e) {
    log.info(`domains: ${e.message}`);
  }
  if (firstRun) {
    state.baselined = true;
    log.info(
      `baseline: ${appsList.length} existing app(s) left as configured; existing deployments not reported`,
    );
  }
  store.save();
  fs.writeFileSync(cfg.heartbeatFile, String(Date.now()));
}

async function main() {
  const { cfg, errors } = loadConfig();
  if (errors.length) {
    for (const e of errors) console.error(`config: ${e}`);
    process.exit(1);
  }
  let ctx;
  try {
    ctx = createContext(cfg);
    ctx.store.save();
  } catch (e) {
    console.error(`cannot use state file ${cfg.stateFile}: ${e.message}`);
    process.exit(1);
  }
  const features = [
    (cfg.previewPortSync || cfg.previewEnvInherit) && "preview follow-ups",
    hasNewAppSettings(cfg) && "new-app settings",
    cfg.githubDeployments && "deployments",
    cfg.githubChecks && "checks",
    cfg.previewCleanup && "preview cleanup",
    hasDomainSettings(cfg) && "new-domain settings",
    cfg.kuma.url && "uptime monitors",
    cfg.dryRun && "DRY RUN",
  ]
    .filter(Boolean)
    .join(", ");
  if (cfg.retiredVars.length) {
    ctx.log.info(
      `${cfg.retiredVars.join(", ")} no longer do anything: dokploy-bridge doesn't copy settings to new apps any more. Remove them.`,
    );
  }
  ctx.log.info(
    `dokploy-bridge ${VERSION} starting: ${features}; polling ${cfg.dokployUrl} every ${cfg.interval / 1000}s`,
  );

  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, () => {
      stopping = true;
      ctx.log.info(`${sig}: stopping`);
      process.exit(0);
    });
  while (!stopping) {
    try {
      await tick(ctx);
    } catch (e) {
      ctx.log.info(`tick failed: ${e.message}`);
    }
    if (cfg.once) break;
    await new Promise((r) => setTimeout(r, cfg.interval));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/src/index.mjs"))
  main();
