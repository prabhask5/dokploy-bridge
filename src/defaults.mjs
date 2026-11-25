// Feature 1: Vercel-style defaults for newly created Dokploy applications.
//
// Settings are captured ONCE from TEMPLATE_APP into defaults.json and from then on read only from
// that file, so the template app can be changed or deleted. Edit defaults.json to change what new
// apps get; delete it to capture again from TEMPLATE_APP.
import fs from 'node:fs';
import path from 'node:path';
import { hasGithubSource } from './util.mjs';

// Saved with application.saveBuildType
export const BUILD_KEYS = ['buildType', 'dockerfile', 'dockerContextPath', 'dockerBuildStage', 'herokuVersion',
  'railpackVersion', 'publishDirectory', 'isStaticSpa'];
// Saved with application.update
export const UPDATE_KEYS = ['autoDeploy', 'rollbackActive', 'rollbackRegistryId',
  'isPreviewDeploymentsActive', 'previewWildcard', 'previewHttps', 'previewCertificateType',
  'previewCustomCertResolver', 'previewPath', 'previewLimit', 'previewRequireCollaboratorPermissions',
  'previewLabels', 'previewPort'];

export async function loadDefaults(ctx, appsList) {
  const { cfg, log, dk } = ctx;
  try {
    return JSON.parse(fs.readFileSync(cfg.defaultsFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') { log.once('defaults-read', `cannot read ${cfg.defaultsFile}: ${e.message}`); return null; }
  }
  const t = cfg.templateApp && appsList.find((x) => x.name === cfg.templateApp || x.appName === cfg.templateApp);
  if (!t) {
    log.once('defaults-none', cfg.templateApp
      ? `template app "${cfg.templateApp}" not found and no ${cfg.defaultsFile}: new apps get no defaults`
      : `TEMPLATE_APP not set and no ${cfg.defaultsFile}: new apps get no defaults`);
    return null;
  }
  const full = await dk('GET', `application.one?applicationId=${t.applicationId}`);
  const snap = { _capturedFrom: full.name, _capturedAt: new Date().toISOString() };
  for (const k of [...BUILD_KEYS, ...UPDATE_KEYS]) if (full[k] !== undefined) snap[k] = full[k];
  if (!cfg.dryRun) {
    fs.mkdirSync(path.dirname(cfg.defaultsFile), { recursive: true });
    fs.writeFileSync(cfg.defaultsFile, JSON.stringify(snap, null, 2) + '\n');
  }
  log.info(`saved defaults from "${full.name}" to ${cfg.defaultsFile}; "${full.name}" is no longer needed for them`);
  return snap;
}

// Runs for apps created after the bridge first started (existing apps are left as configured).
export async function applyDefaults(ctx, a, s, appsList) {
  const { cfg, log, dk, store } = ctx;
  if (!s.defaults) {
    const t = cfg.defaults ? await loadDefaults(ctx, appsList) : null;
    if (t) {
      await dk('POST', 'application.saveBuildType', {
        applicationId: a.applicationId, buildType: t.buildType || 'dockerfile', dockerfile: t.dockerfile || 'Dockerfile',
        dockerContextPath: t.dockerContextPath ?? null, dockerBuildStage: t.dockerBuildStage ?? null,
        herokuVersion: t.herokuVersion ?? null, railpackVersion: t.railpackVersion ?? null,
        publishDirectory: t.publishDirectory ?? null, isStaticSpa: t.isStaticSpa ?? false,
      });
      const upd = { applicationId: a.applicationId };
      for (const k of UPDATE_KEYS) if (t[k] !== undefined && t[k] !== null) upd[k] = t[k];
      await dk('POST', 'application.update', upd);
      log.info(`[${a.name}] applied saved defaults`);
    }
    s.defaults = true; store.save();
  }

  if (!hasGithubSource(a)) return;

  // Previews must listen on the same port as the app: follow the first domain you add.
  if (cfg.previewPortSync && !s.previewPortSynced) {
    const d = (a.domains || []).find((x) => (x.domainType || 'application') === 'application');
    if (d) {
      if (d.port && d.port !== a.previewPort) {
        await dk('POST', 'application.update', { applicationId: a.applicationId, previewPort: d.port });
        log.info(`[${a.name}] preview port set to ${d.port} to match ${d.host}`);
      }
      s.previewPortSynced = true; store.save();
    }
  }

  // Previews use the production environment variables until you set preview variables yourself.
  if (cfg.previewEnvInherit) {
    const env = a.env || '', pEnv = a.previewEnv || '';
    if (env && (pEnv === '' || pEnv === s.previewEnvWritten) && pEnv !== env) {
      await dk('POST', 'application.update', { applicationId: a.applicationId, previewEnv: env });
      s.previewEnvWritten = env; store.save();
      log.info(`[${a.name}] previews now use the production environment variables`);
    }
  }
}
