import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shaOf,
  monitorMarkers,
  exposedPort,
  dockerfilePath,
  hostOf,
  fmtDuration,
  secretValues,
  maskSecrets,
  stripAnsi,
  prodUrl,
  previewUrl,
  dashboardUrl,
  previewEnvName,
  previewEnvPattern,
  isIgnored,
  hasGithubSource,
} from "../../src/util.mjs";

test('shaOf reads "Hash:" and "Commit:" descriptions', () => {
  assert.equal(shaOf({ description: "Hash: ABC1234def" }), "abc1234def");
  assert.equal(
    shaOf({ description: "Rebuild\nCommit: 0123456789abcdef0123456789abcdef01234567" }),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(shaOf({ description: "Manual deployment" }), undefined);
  assert.equal(shaOf(undefined), undefined);
});

test("fmtDuration", () => {
  assert.equal(fmtDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z"), "42s");
  assert.equal(fmtDuration("2026-01-01T00:00:00Z", "2026-01-01T00:02:05Z"), "2m 5s");
  assert.equal(fmtDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z"), "");
  assert.equal(fmtDuration(undefined, "2026-01-01T00:00:00Z"), "");
});

test("secretValues + maskSecrets hide env values, longest first, ignoring short ones", () => {
  const secrets = secretValues(
    'API_KEY=supersecret123\nexport TOKEN="tok_abcdef"\nPORT=3000',
    "X=supersecret12345",
  );
  assert.deepEqual(secrets, ["supersecret12345", "supersecret123", "tok_abcdef"]);
  assert.equal(
    maskSecrets("key supersecret12345 and tok_abcdef, port 3000", secrets),
    "key *** and ***, port 3000",
  );
});

test("stripAnsi removes colour codes and carriage returns", () => {
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m\r\n"), "ok\n");
});

test("prodUrl uses the first application domain", () => {
  assert.equal(prodUrl({ domains: [{ host: "a.com", https: true }] }), "https://a.com");
  assert.equal(
    prodUrl({ domains: [{ host: "a.com", https: false, path: "/app" }] }),
    "http://a.com/app",
  );
  assert.equal(prodUrl({ domains: [{ host: "p.com", domainType: "preview" }] }), undefined);
  assert.equal(prodUrl({}), undefined);
});

test("previewUrl and dashboardUrl", () => {
  assert.equal(previewUrl({ domain: { host: "pr-1.a.com" } }), "https://pr-1.a.com");
  assert.equal(previewUrl({}), undefined);
  const a = { applicationId: "A", environmentId: "E", environment: { projectId: "P" } };
  assert.equal(
    dashboardUrl("https://dok.example", a),
    "https://dok.example/dashboard/project/P/environment/E/services/application/A",
  );
  assert.equal(dashboardUrl("", a), undefined);
});

test("preview environment names round-trip through the pattern", () => {
  const t = "Preview (PR #{pr})";
  assert.equal(previewEnvName(t, 12), "Preview (PR #12)");
  const re = previewEnvPattern(t);
  assert.ok(re.test("Preview (PR #12)"));
  assert.ok(!re.test("Production"));
  assert.ok(!re.test("Preview (PR #12) extra"));
  assert.ok(previewEnvPattern("pr-{pr}.preview").test("pr-7.preview"));
  assert.ok(!previewEnvPattern("pr-{pr}.preview").test("pr-7xpreview"));
});

test("isIgnored: description marker or IGNORE_APPS", () => {
  assert.ok(isIgnored({ description: "my app. dokploy-bridge: off" }));
  assert.ok(isIgnored({ name: "bridge" }, ["bridge"]));
  assert.ok(isIgnored({ appName: "bridge-x1" }, ["bridge-x1"]));
  assert.ok(!isIgnored({ name: "web", description: "hello" }, ["bridge"]));
});

test("hasGithubSource", () => {
  assert.ok(hasGithubSource({ sourceType: "github", githubId: "g", owner: "o", repository: "r" }));
  assert.ok(!hasGithubSource({ sourceType: "git", githubId: "g", owner: "o", repository: "r" }));
  assert.ok(!hasGithubSource({ sourceType: "github", owner: "o", repository: "r" }));
});

test("monitorMarkers reads monitor, health and keyword lines from a description", () => {
  assert.deepEqual(
    monitorMarkers("My planner\nMonitor: Stellar Planner \nhealth: api/health\nkeyword: ok"),
    { off: false, name: "Stellar Planner", health: "/api/health", keyword: "ok" },
  );
  assert.equal(monitorMarkers("monitor: OFF").off, true);
  assert.equal(monitorMarkers("monitor: OFF").name, undefined);
  assert.deepEqual(monitorMarkers(null), {
    off: false,
    name: undefined,
    health: undefined,
    keyword: undefined,
  });
});

test("exposedPort takes the built stage's last EXPOSE", () => {
  const df = [
    "FROM --platform=$BUILDPLATFORM node:24 AS deps",
    "EXPOSE 9229",
    "FROM nginx:1.30 AS web",
    "EXPOSE 8080/tcp 9000",
    "EXPOSE \\",
    "  80",
    'CMD ["nginx"]',
  ].join("\n");
  assert.equal(exposedPort(df), 80);
  assert.equal(exposedPort(df, "deps"), 9229);
  assert.equal(exposedPort("FROM node\nEXPOSE $PORT"), undefined);
  assert.equal(exposedPort(""), undefined);
});

test("dockerfilePath joins the build path and Dockerfile like Dokploy", () => {
  assert.equal(dockerfilePath({}), "Dockerfile");
  assert.equal(dockerfilePath({ buildPath: "/", dockerfile: "./Dockerfile" }), "Dockerfile");
  assert.equal(
    dockerfilePath({ buildPath: "/apps/web/", dockerfile: "docker/Prod" }),
    "apps/web/docker/Prod",
  );
});

test("hostOf", () => {
  assert.equal(hostOf("https://Planner.example.com/api/health"), "planner.example.com");
  assert.equal(hostOf("not a url"), undefined);
  assert.equal(hostOf(undefined), undefined);
});
