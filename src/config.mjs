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
      buildType: opt(env.NEW_APP_BUILD_TYPE),
    },
    // Settings applied once to application domains added after this feature first ran (all optional)
    newDomain: {
      https: optBool(env.NEW_DOMAIN_HTTPS),
      certificate: opt(env.NEW_DOMAIN_CERTIFICATE),
      portFromDockerfile: bool(env.NEW_DOMAIN_PORT_FROM_DOCKERFILE, false),
    },
    // Uptime Kuma monitors for new application domains (off unless KUMA_URL is set)
    kuma: {
      url: stripSlash(str(env.KUMA_URL, "")),
      username: str(env.KUMA_USERNAME, ""),
      password: str(env.KUMA_PASSWORD, ""),
      interval: num(env.KUMA_MONITOR_INTERVAL, 60),
      retries: num(env.KUMA_MONITOR_RETRIES, 2),
      retryInterval: num(env.KUMA_MONITOR_RETRY_INTERVAL, 20),
      timeout: num(env.KUMA_MONITOR_TIMEOUT, 48),
      resend: num(env.KUMA_MONITOR_RESEND, 0),
      expiryNotification: bool(env.KUMA_MONITOR_EXPIRY_NOTIFICATION, true),
      maxRedirects: num(env.KUMA_MONITOR_MAX_REDIRECTS, 10),
      acceptedStatus: list(str(env.KUMA_MONITOR_ACCEPTED_STATUS, "200-299")),
      notifications: list(env.KUMA_MONITOR_NOTIFICATIONS),
      maxDeletes: num(env.KUMA_MAX_DELETES_PER_TICK, 3),
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
    ["KUMA_URL", cfg.kuma.url],
  ]) {
    if (v && !/^https?:\/\/[^/]/.test(v)) errors.push(`${k} must be an http(s) URL, got "${v}"`);
  }
  for (const k of [
    "NEW_APP_PREVIEWS",
    "NEW_APP_PREVIEW_HTTPS",
    "NEW_APP_PREVIEW_COLLABORATORS_ONLY",
    "NEW_DOMAIN_HTTPS",
  ]) {
    if (opt(env[k]) !== undefined && !BOOL_RE.test(opt(env[k])))
      errors.push(`${k} must be true or false, got "${env[k]}"`);
  }
  const { previewCertificate: cert, previewLimit: limit, buildType } = cfg.newApp;
  const BUILD_TYPES = [
    "dockerfile",
    "nixpacks",
    "railpack",
    "heroku_buildpacks",
    "paketo_buildpacks",
    "static",
  ];
  if (buildType !== undefined && !BUILD_TYPES.includes(buildType))
    errors.push(`NEW_APP_BUILD_TYPE must be one of ${BUILD_TYPES.join(", ")}, got "${buildType}"`);
  if (cert !== undefined && !["none", "letsencrypt", "custom"].includes(cert))
    errors.push(`NEW_APP_PREVIEW_CERTIFICATE must be none, letsencrypt or custom, got "${cert}"`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1))
    errors.push(
      `NEW_APP_PREVIEW_LIMIT must be a whole number of 1 or more, got "${env.NEW_APP_PREVIEW_LIMIT}"`,
    );
  const { certificate: domainCert } = cfg.newDomain;
  if (domainCert !== undefined && !["none", "letsencrypt", "custom"].includes(domainCert))
    errors.push(`NEW_DOMAIN_CERTIFICATE must be none, letsencrypt or custom, got "${domainCert}"`);
  const k = cfg.kuma;
  if (k.url && (!k.username || !k.password))
    errors.push("KUMA_USERNAME and KUMA_PASSWORD are required when KUMA_URL is set");
  for (const [name, v, min] of [
    ["KUMA_MONITOR_INTERVAL", k.interval, 20],
    ["KUMA_MONITOR_RETRIES", k.retries, 0],
    ["KUMA_MONITOR_RETRY_INTERVAL", k.retryInterval, 20],
    ["KUMA_MONITOR_TIMEOUT", k.timeout, 1],
    ["KUMA_MONITOR_RESEND", k.resend, 0],
    ["KUMA_MONITOR_MAX_REDIRECTS", k.maxRedirects, 0],
    ["KUMA_MAX_DELETES_PER_TICK", k.maxDeletes, 0],
  ]) {
    if (!(Number.isInteger(v) && v >= min))
      errors.push(`${name} must be a whole number of ${min} or more, got "${env[name]}"`);
  }
  if (!k.acceptedStatus.every((c) => /^\d{3}(-\d{3})?$/.test(c)))
    errors.push(
      `KUMA_MONITOR_ACCEPTED_STATUS must be status codes or ranges like 200-299, got "${env.KUMA_MONITOR_ACCEPTED_STATUS}"`,
    );
  if (cfg.checkNameProduction === cfg.checkNamePreview)
    errors.push("CHECK_NAME_PRODUCTION and CHECK_NAME_PREVIEW must differ");
  return { cfg, errors };
}
