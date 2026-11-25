// Small pure helpers (no I/O), unit-tested in tests/unit/util.test.mjs.

// Dokploy tags Git-triggered deploys "Hash: <sha>" while running and "Commit: <sha>" once done
// (depending on the Dokploy version), so accept both, anywhere in the description.
export const shaOf = (dep) =>
  (/\b(?:Hash|Commit):\s*([0-9a-f]{7,40})\b/i.exec(dep?.description || "") || [])[1]?.toLowerCase();

export const hasGithubSource = (a) =>
  Boolean(a?.sourceType === "github" && a.githubId && a.owner && a.repository);

export const repoOf = (a) => `${a.owner}/${a.repository}`;

export function fmtDuration(from, to) {
  const ms = Date.parse(to || "") - Date.parse(from || "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

// eslint-disable-next-line no-control-regex -- ANSI escape codes start with the ESC control character
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

// Values from KEY=value lines (env, preview env, build args) that are long enough to be secrets.
export function secretValues(...blocks) {
  return blocks
    .join("\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "")
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter((v) => v.length >= 6)
    .sort((x, y) => y.length - x.length); // longest first, so a value containing another is masked whole
}

export function maskSecrets(text, secrets) {
  let out = text;
  for (const v of secrets) out = out.split(v).join("***");
  return out;
}

// The app's main URL: its first application domain.
export function prodUrl(a) {
  const d = (a.domains || []).find((x) => (x.domainType || "application") === "application");
  return d
    ? `${d.https ? "https" : "http"}://${d.host}${d.path && d.path !== "/" ? d.path : ""}`
    : undefined;
}

export const previewUrl = (p) =>
  p?.domain?.host ? `${p.domain.https === false ? "http" : "https"}://${p.domain.host}` : undefined;

export const dashboardUrl = (publicUrl, a) =>
  publicUrl && a.environment && a.environmentId
    ? `${publicUrl}/dashboard/project/${a.environment.projectId}/environment/${a.environmentId}/services/application/${a.applicationId}`
    : undefined;

// GitHub environment names for previews, from a template such as "Preview (PR #{pr})".
export const previewEnvName = (template, pr) => template.replaceAll("{pr}", String(pr));
export function previewEnvPattern(template) {
  const esc = template.split("{pr}").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${esc.join("(\\d+)")}$`);
}

// An app opts out of the bridge with "dokploy-bridge: off" in its Dokploy description,
// or by being listed (name or appName) in IGNORE_APPS.
export const isIgnored = (a, ignoreApps = []) =>
  /dokploy-bridge\s*:\s*off/i.test(a?.description || "") ||
  ignoreApps.includes(a?.name) ||
  ignoreApps.includes(a?.appName);
