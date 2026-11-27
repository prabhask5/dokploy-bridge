// Settings applied once to every app created after the bridge's first run, from NEW_APP_*
// environment variables (all optional; an unset variable leaves Dokploy's own value alone):
//  - rollbacks: on, with the given registry, as soon as the app appears
//  - build type: as soon as the app appears, only if it still has Dokploy's default (Nixpacks)
//  - preview settings: as soon as the app deploys from GitHub (previews need GitHub), which
//    may be a little after it's created, since the repository is often connected second
// Apps that existed before this feature (or before the bridge) are never touched.
import { hasGithubSource } from "./util.mjs";

// state.apps[id].newApp: "pending" parts still to apply, "done" (or "n/a" for older apps).
export const newAppState = (fresh) =>
  fresh
    ? { rollback: "pending", previews: "pending", build: "pending" }
    : { rollback: "n/a", previews: "n/a", build: "n/a" };

const DOKPLOY_DEFAULT_BUILD_TYPE = "nixpacks";

export const previewSettings = (n) => {
  const out = {};
  if (n.previews !== undefined) out.isPreviewDeploymentsActive = n.previews;
  if (n.previewWildcard !== undefined) out.previewWildcard = n.previewWildcard;
  if (n.previewHttps !== undefined) out.previewHttps = n.previewHttps;
  if (n.previewCertificate !== undefined) out.previewCertificateType = n.previewCertificate;
  if (n.previewLimit !== undefined) out.previewLimit = n.previewLimit;
  if (n.previewCollaboratorsOnly !== undefined)
    out.previewRequireCollaboratorPermissions = n.previewCollaboratorsOnly;
  return out;
};

export const hasNewAppSettings = (cfg) =>
  Boolean(cfg.newApp.rollbackRegistry) ||
  Boolean(cfg.newApp.buildType) ||
  Object.keys(previewSettings(cfg.newApp)).length > 0;

// NEW_APP_ROLLBACK_REGISTRY may be a registry's ID or its name in Dokploy.
async function registryId(ctx) {
  const { cfg, log, dk, flags } = ctx;
  if (flags.registryId !== undefined) return flags.registryId;
  const want = cfg.newApp.rollbackRegistry;
  let list;
  try {
    list = await dk("GET", "registry.all");
  } catch (e) {
    log.debug(`registry.all: ${e.message}; using NEW_APP_ROLLBACK_REGISTRY as an ID`);
    return (flags.registryId = want);
  }
  const r = (list || []).find((x) => x.registryId === want || x.registryName === want);
  if (!r) {
    log.once(
      "registry-missing",
      `NEW_APP_ROLLBACK_REGISTRY "${want}" matches no registry in Dokploy (by ID or name): rollbacks not turned on for new apps`,
    );
    return (flags.registryId = null);
  }
  return (flags.registryId = r.registryId);
}

export async function applyNewAppSettings(ctx, a, s) {
  const { cfg, log, dk, store } = ctx;
  const n = s.newApp;
  if (!n || (n.rollback !== "pending" && n.previews !== "pending" && n.build !== "pending")) return;
  const upd = {};
  const parts = [];
  let rollbackDone = false,
    previewsDone = false,
    buildDone = false;

  if (n.rollback === "pending") {
    rollbackDone = true;
    if (cfg.newApp.rollbackRegistry) {
      const id = await registryId(ctx);
      if (id) {
        upd.rollbackActive = true;
        upd.rollbackRegistryId = id;
        parts.push("rollbacks on");
      }
    }
  }
  if (n.build === "pending") {
    buildDone = true;
    const want = cfg.newApp.buildType;
    // Only replace Dokploy's default: a build type you already picked is yours.
    if (want && a.buildType === DOKPLOY_DEFAULT_BUILD_TYPE && want !== a.buildType) {
      upd.buildType = want;
      parts.push(`build type ${want}`);
    }
  }
  if (n.previews === "pending" && hasGithubSource(a)) {
    previewsDone = true;
    const p = previewSettings(cfg.newApp);
    Object.assign(upd, p);
    if (Object.keys(p).length) parts.push("preview settings");
  }

  if (Object.keys(upd).length) {
    await dk("POST", "application.update", { applicationId: a.applicationId, ...upd });
    log.info(`[${a.name}] new app: ${parts.join(", ")} applied`);
  }
  if (rollbackDone) n.rollback = "done";
  if (previewsDone) n.previews = "done";
  if (buildDone) n.build = "done";
  if (rollbackDone || previewsDone || buildDone) store.save();
}
