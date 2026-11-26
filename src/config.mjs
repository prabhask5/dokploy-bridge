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
  if (cfg.checkNameProduction === cfg.checkNamePreview)
    errors.push("CHECK_NAME_PRODUCTION and CHECK_NAME_PREVIEW must differ");
  return { cfg, errors };
}
