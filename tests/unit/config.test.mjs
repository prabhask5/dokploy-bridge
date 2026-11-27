import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.mjs";

test("defaults", () => {
  const { cfg, errors } = loadConfig({ DOKPLOY_API_KEY: "k" });
  assert.deepEqual(errors, []);
  assert.equal(cfg.dokployUrl, "http://dokploy:3000");
  assert.equal(cfg.interval, 10000);
  assert.equal(cfg.stateFile, "/data/state.json");
  assert.equal(cfg.checkNameProduction, "Dokploy");
  assert.equal(cfg.environmentPreview, "Preview (PR #{pr})");
  assert.equal(cfg.previewCleanup, true);
  assert.equal(cfg.dryRun, false);
});

test("overrides, booleans, lists, legacy DOKPLOY_INTERNAL_URL", () => {
  const { cfg } = loadConfig({
    DOKPLOY_API_KEY: "k",
    DOKPLOY_INTERNAL_URL: "http://dok:3000/",
    DOKPLOY_PUBLIC_URL: "https://deploy.example.com/",
    POLL_SECONDS: "30",
    DATA_DIR: "/var/lib/bridge/",
    PREVIEW_CLEANUP: "false",
    DRY_RUN: "yes",
    IGNORE_APPS: "a, b ,",
    CHECK_NAME_PRODUCTION: "Production",
    CHECK_NAME_PREVIEW: "Preview",
  });
  assert.equal(cfg.dokployUrl, "http://dok:3000");
  assert.equal(cfg.dokployPublicUrl, "https://deploy.example.com");
  assert.equal(cfg.interval, 30000);
  assert.equal(cfg.stateFile, "/var/lib/bridge/state.json");
  assert.equal(cfg.previewCleanup, false);
  assert.equal(cfg.dryRun, true);
  assert.deepEqual(cfg.ignoreApps, ["a", "b"]);
  assert.equal(
    loadConfig({
      DOKPLOY_API_KEY: "k",
      DOKPLOY_URL: "http://new:1",
      DOKPLOY_INTERNAL_URL: "http://old:2",
    }).cfg.dokployUrl,
    "http://new:1",
  );
});

test("poll interval has a floor of 5s", () => {
  assert.equal(loadConfig({ DOKPLOY_API_KEY: "k", POLL_SECONDS: "1" }).cfg.interval, 5000);
});

test("retired template settings are reported, not used", () => {
  assert.deepEqual(
    loadConfig({ DOKPLOY_API_KEY: "k", TEMPLATE_APP: "shortless" }).cfg.retiredVars,
    ["TEMPLATE_APP"],
  );
  assert.deepEqual(loadConfig({ DOKPLOY_API_KEY: "k" }).cfg.retiredVars, []);
});

test("new-app settings: unset means leave alone; values parsed and validated", () => {
  assert.deepEqual(loadConfig({ DOKPLOY_API_KEY: "k" }).cfg.newApp, {
    previews: undefined,
    previewWildcard: undefined,
    previewHttps: undefined,
    previewCertificate: undefined,
    previewLimit: undefined,
    previewCollaboratorsOnly: undefined,
    rollbackRegistry: undefined,
  });
  const { cfg, errors } = loadConfig({
    DOKPLOY_API_KEY: "k",
    NEW_APP_PREVIEWS: "false",
    NEW_APP_PREVIEW_LIMIT: "2",
    NEW_APP_PREVIEW_WILDCARD: " *.example.com ",
  });
  assert.deepEqual(errors, []);
  assert.equal(cfg.newApp.previews, false);
  assert.equal(cfg.newApp.previewLimit, 2);
  assert.equal(cfg.newApp.previewWildcard, "*.example.com");
  const bad = loadConfig({
    DOKPLOY_API_KEY: "k",
    NEW_APP_PREVIEWS: "sure",
    NEW_APP_PREVIEW_CERTIFICATE: "acme",
    NEW_APP_PREVIEW_LIMIT: "0",
  }).errors.join("\n");
  assert.match(bad, /NEW_APP_PREVIEWS must be true or false/);
  assert.match(bad, /NEW_APP_PREVIEW_CERTIFICATE must be none, letsencrypt or custom/);
  assert.match(bad, /NEW_APP_PREVIEW_LIMIT must be a whole number/);
});

test("validation errors", () => {
  assert.match(loadConfig({}).errors.join(), /DOKPLOY_API_KEY is required/);
  assert.match(
    loadConfig({ DOKPLOY_API_KEY: "k", ENVIRONMENT_PREVIEW: "Preview" }).errors.join(),
    /must contain \{pr\}/,
  );
  assert.match(
    loadConfig({ DOKPLOY_API_KEY: "k", DOKPLOY_URL: "dokploy:3000" }).errors.join(),
    /DOKPLOY_URL must be an http/,
  );
  assert.match(
    loadConfig({
      DOKPLOY_API_KEY: "k",
      CHECK_NAME_PRODUCTION: "X",
      CHECK_NAME_PREVIEW: "X",
    }).errors.join(),
    /must differ/,
  );
});
