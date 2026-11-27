// Configuration, read once from environment variables. See README "Configuration".

const bool = (v, def) => {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const num = (v, def) => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? def : n;
};
const str = (v, def) => (v === undefined || v === "" ? def : String(v));
const stripSlash = (s) => s.replace(/\/+$/, "");
// Optional settings: undefined when unset, so "not set" means "leave Dokploy's value alone".
const opt = (v) => (v === undefined || String(v).trim() === "" ? undefined : String(v).trim());
const BOOL_RE = /^(1|0|true|false|yes|no|on|off)$/i;
const optBool = (v) => (opt(v) === undefined ? undefined : /^(1|true|yes|on)$/i.test(opt(v)));
const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const dataDir = stripSlash(str(env.DATA_DIR, "/data"));
  const cfg = {
    // Dokploy
    dokployUrl: stripSlash(
      str(env.DOKPLOY_URL, str(env.DOKPLOY_INTERNAL_URL, "http://dokploy:3000")),
    ),
    dokployPublicUrl: stripSlash(str(env.DOKPLOY_PUBLIC_URL, "")),
    apiKey: str(env.DOKPLOY_API_KEY, ""),
    // GitHub (auto-detected from Dokploy's GitHub provider when empty)
    githubApi: stripSlash(str(env.GITHUB_API_URL, "")),
    // Loop and files
    interval: Math.max(5, num(env.POLL_SECONDS, 10)) * 1000,
    stateFile: str(env.STATE_FILE, `${dataDir}/state.json`),
    heartbeatFile: str(env.HEARTBEAT_FILE, "/tmp/dokploy-bridge.heartbeat"),
    once: bool(env.ONCE, false),
    dryRun: bool(env.DRY_RUN, false),
    debug: /^debug$/i.test(str(env.LOG_LEVEL, "info")),
    // Which apps
    ignoreApps: list(env.IGNORE_APPS),
    // Features
    previewPortSync: bool(env.PREVIEW_PORT_SYNC, true),
    previewEnvInherit: bool(env.PREVIEW_ENV_INHERIT, true),
    githubDeployments: bool(env.GITHUB_DEPLOYMENTS, true),
    githubChecks: bool(env.GITHUB_CHECKS, true),
    previewCleanup: bool(env.PREVIEW_CLEANUP, true),
    deletePreviewEnvironments: bool(env.DELETE_PREVIEW_ENVIRONMENTS, true),
    // Settings applied once to apps created after the bridge's first run (all optional)
    newApp: {
      previews: optBool(env.NEW_APP_PREVIEWS),
      previewWildcard: opt(env.NEW_APP_PREVIEW_WILDCARD),
      previewHttps: optBool(env.NEW_APP_PREVIEW_HTTPS),
      previewCertificate: opt(env.NEW_APP_PREVIEW_CERTIFICATE),
      previewLimit:
        opt(env.NEW_APP_PREVIEW_LIMIT) === undefined
          ? undefined
          : Number(env.NEW_APP_PREVIEW_LIMIT),
      previewCollaboratorsOnly: optBool(env.NEW_APP_PREVIEW_COLLABORATORS_ONLY),
      rollbackRegistry: opt(env.NEW_APP_ROLLBACK_REGISTRY),
    },
    // Names shown on GitHub
    checkNameProduction: str(env.CHECK_NAME_PRODUCTION, "Dokploy"),
    checkNamePreview: str(env.CHECK_NAME_PREVIEW, "Dokploy Preview"),
    environmentProduction: str(env.ENVIRONMENT_PRODUCTION, "Production"),
    environmentPreview: str(env.ENVIRONMENT_PREVIEW, "Preview (PR #{pr})"),
    // Check report
    logLinesSuccess: Math.max(0, num(env.LOG_TAIL_LINES_SUCCESS, 25)),
    logLinesFailure: Math.max(0, num(env.LOG_TAIL_LINES_FAILURE, 80)),
  };

  // Settings from versions that copied a template app's settings to new apps (removed).
  cfg.retiredVars = ["TEMPLATE_APP", "DEFAULTS", "DEFAULTS_FILE"].filter(
    (k) => env[k] !== undefined,
  );

  const errors = [];
  if (!cfg.apiKey)
    errors.push(
      "DOKPLOY_API_KEY is required (an owner or admin API key from Dokploy -> Settings -> Profile)",
    );
  if (!cfg.environmentPreview.includes("{pr}"))
    errors.push('ENVIRONMENT_PREVIEW must contain {pr}, e.g. "Preview (PR #{pr})"');
  for (const [k, v] of [
    ["DOKPLOY_URL", cfg.dokployUrl],
    ["DOKPLOY_PUBLIC_URL", cfg.dokployPublicUrl],
    ["GITHUB_API_URL", cfg.githubApi],
  ]) {
    if (v && !/^https?:\/\/[^/]/.test(v)) errors.push(`${k} must be an http(s) URL, got "${v}"`);
  }
  for (const k of [
    "NEW_APP_PREVIEWS",
    "NEW_APP_PREVIEW_HTTPS",
    "NEW_APP_PREVIEW_COLLABORATORS_ONLY",
  ]) {
    if (opt(env[k]) !== undefined && !BOOL_RE.test(opt(env[k])))
      errors.push(`${k} must be true or false, got "${env[k]}"`);
  }
  const { previewCertificate: cert, previewLimit: limit } = cfg.newApp;
  if (cert !== undefined && !["none", "letsencrypt", "custom"].includes(cert))
    errors.push(`NEW_APP_PREVIEW_CERTIFICATE must be none, letsencrypt or custom, got "${cert}"`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1))
    errors.push(
      `NEW_APP_PREVIEW_LIMIT must be a whole number of 1 or more, got "${env.NEW_APP_PREVIEW_LIMIT}"`,
    );
  if (cfg.checkNameProduction === cfg.checkNamePreview)
    errors.push("CHECK_NAME_PRODUCTION and CHECK_NAME_PREVIEW must differ");
  return { cfg, errors };
}
