import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { applyNewAppSettings, newAppState, previewSettings } from "../../src/newapps.mjs";
import { tick } from "../../src/index.mjs";
import { loadConfig } from "../../src/config.mjs";
import { ctxWith, testConfig, memoryStore, fakeGitHub, app } from "../support/helpers.mjs";

const MINE = {
  NEW_APP_PREVIEWS: "true",
  NEW_APP_PREVIEW_WILDCARD: "*.example.com",
  NEW_APP_PREVIEW_HTTPS: "true",
  NEW_APP_PREVIEW_CERTIFICATE: "none",
  NEW_APP_PREVIEW_LIMIT: "2",
  NEW_APP_PREVIEW_COLLABORATORS_ONLY: "true",
  NEW_APP_ROLLBACK_REGISTRY: "my-registry",
};
const registries = [{ registryId: "reg-123", registryName: "my-registry" }];

function dokploy(extra = {}) {
  const writes = [];
  const dk = async (method, p, body) => {
    if (p === "registry.all") return registries;
    if (method === "POST") return writes.push([p, body]);
    return extra[p.split("?")[0]];
  };
  return { writes, dk };
}

test("a new GitHub app gets rollbacks and every preview setting in one update", async () => {
  const { writes, dk } = dokploy();
  const ctx = ctxWith({ dk, cfg: testConfig(MINE) });
  const s = { newApp: newAppState(true) };
  await applyNewAppSettings(ctx, app(), s);
  assert.deepEqual(writes, [
    [
      "application.update",
      {
        applicationId: "app1",
        rollbackActive: true,
        rollbackRegistryId: "reg-123", // the name was resolved to the ID
        isPreviewDeploymentsActive: true,
        previewWildcard: "*.example.com",
        previewHttps: true,
        previewCertificateType: "none",
        previewLimit: 2,
        previewRequireCollaboratorPermissions: true,
      },
    ],
  ]);
  assert.deepEqual(s.newApp, { rollback: "done", previews: "done", build: "done" });
  writes.length = 0;
  await applyNewAppSettings(ctx, app(), s);
  assert.equal(writes.length, 0, "applied once, never again");
});

test("preview settings wait until the app is connected to GitHub", async () => {
  const { writes, dk } = dokploy();
  const ctx = ctxWith({ dk, cfg: testConfig(MINE) });
  const s = { newApp: newAppState(true) };
  await applyNewAppSettings(ctx, app({ sourceType: "git", githubId: null }), s);
  assert.deepEqual(Object.keys(writes[0][1]), [
    "applicationId",
    "rollbackActive",
    "rollbackRegistryId",
  ]);
  assert.deepEqual(s.newApp, { rollback: "done", previews: "pending", build: "done" });
  writes.length = 0;
  await applyNewAppSettings(ctx, app(), s); // repository connected later
  assert.equal(writes[0][1].previewWildcard, "*.example.com");
  assert.equal(writes[0][1].rollbackActive, undefined);
  assert.deepEqual(s.newApp, { rollback: "done", previews: "done", build: "done" });
});

test("only the variables you set are written", async () => {
  const { writes, dk } = dokploy();
  const ctx = ctxWith({ dk, cfg: testConfig({ NEW_APP_PREVIEW_LIMIT: "5" }) });
  await applyNewAppSettings(ctx, app(), { newApp: newAppState(true) });
  assert.deepEqual(writes, [["application.update", { applicationId: "app1", previewLimit: 5 }]]);
  assert.deepEqual(previewSettings(testConfig().newApp), {});
});

test("nothing set: nothing written", async () => {
  const { writes, dk } = dokploy();
  const s = { newApp: newAppState(true) };
  await applyNewAppSettings(ctxWith({ dk }), app(), s);
  assert.equal(writes.length, 0);
  assert.deepEqual(s.newApp, { rollback: "done", previews: "done", build: "done" });
});

test("an unknown registry turns rollbacks off for new apps, said once", async () => {
  const { writes, dk } = dokploy();
  const ctx = ctxWith({ dk, cfg: testConfig({ NEW_APP_ROLLBACK_REGISTRY: "nope" }) });
  await applyNewAppSettings(ctx, app(), { newApp: newAppState(true) });
  await applyNewAppSettings(ctx, app({ applicationId: "app2" }), { newApp: newAppState(true) });
  assert.equal(writes.length, 0);
  assert.equal(ctx.log.lines.filter((l) => l.includes("matches no registry")).length, 1);
});

test("a registry ID is used as-is when Dokploy can't list registries", async () => {
  const writes = [];
  const dk = async (method, p, body) => {
    if (p === "registry.all") throw new Error("404");
    if (method === "POST") writes.push([p, body]);
  };
  const ctx = ctxWith({ dk, cfg: testConfig({ NEW_APP_ROLLBACK_REGISTRY: "raw-id" }) });
  await applyNewAppSettings(ctx, app(), { newApp: newAppState(true) });
  assert.equal(writes[0][1].rollbackRegistryId, "raw-id");
});

test("tick: only apps that appear after the first run get the settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-newapps-"));
  let apps = [{ applicationId: "old", name: "old" }];
  const full = (id) => app({ applicationId: id, name: id, previewPort: 3000, env: "" });
  const writes = [];
  const dk = async (method, p, body) => {
    if (p === "project.all") return [{ environments: [{ applications: apps }] }];
    if (p.startsWith("application.one"))
      return full(new URL(`http://x/${p}`).searchParams.get("applicationId"));
    if (p === "registry.all") return registries;
    if (p.startsWith("previewDeployment.all")) return [];
    if (method === "POST") writes.push([p, body]);
    return null;
  };
  const store = memoryStore({ baselined: false });
  const cfg = testConfig({ ...MINE, HEARTBEAT_FILE: path.join(dir, "hb") });
  const ctx = ctxWith({ dk, gh: fakeGitHub().gh, store, cfg });
  await tick(ctx); // first run: "old" is baseline
  // An app created after the first run, but before this feature existed, has no newApp state:
  store.state.apps.between = { baseline: false };
  apps = [
    ...apps,
    { applicationId: "between", name: "between" },
    { applicationId: "new", name: "new" },
  ];
  await tick(ctx);
  const touched = writes
    .filter(([p]) => p === "application.update")
    .map(([, b]) => b.applicationId);
  assert.deepEqual(touched, ["new"]);
  assert.deepEqual(store.state.apps.between.newApp, {
    rollback: "n/a",
    previews: "n/a",
    build: "n/a",
  });
});

test("a new app gets NEW_APP_BUILD_TYPE with its rollbacks, only over Dokploy's default", async () => {
  const cfg = testConfig({ ...MINE, NEW_APP_BUILD_TYPE: "dockerfile" });
  const { writes, dk } = dokploy();
  const ctx = ctxWith({ dk, cfg });
  const s = { newApp: newAppState(true) };
  await applyNewAppSettings(
    ctx,
    app({ sourceType: "github", githubId: null, buildType: "nixpacks" }),
    s,
  );
  assert.deepEqual(writes, [
    [
      "application.update",
      {
        applicationId: "app1",
        rollbackActive: true,
        rollbackRegistryId: "reg-123",
        buildType: "dockerfile",
      },
    ],
  ]);
  assert.equal(s.newApp.build, "done");

  writes.length = 0;
  const picked = { newApp: newAppState(true) };
  await applyNewAppSettings(ctx, app({ buildType: "railpack" }), picked);
  assert.ok(!("buildType" in writes[0][1]), "a build type you picked is kept");
  assert.equal(picked.newApp.build, "done");
});

test("NEW_APP_BUILD_TYPE is validated", () => {
  assert.equal(testConfig({ NEW_APP_BUILD_TYPE: "dockerfile" }).newApp.buildType, "dockerfile");
  const { errors } = loadConfig({ DOKPLOY_API_KEY: "k", NEW_APP_BUILD_TYPE: "docker" });
  assert.match(errors.join("\n"), /NEW_APP_BUILD_TYPE must be one of dockerfile/);
});
