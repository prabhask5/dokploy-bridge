import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpNewApp } from "../../src/previews.mjs";
import { ctxWith, testConfig, app } from "../support/helpers.mjs";

const recorder = () => {
  const writes = [];
  return { writes, dk: async (method, path, body) => writes.push([path, body]) };
};

test("preview port follows the first domain, once", async () => {
  const { writes, dk } = recorder();
  const ctx = ctxWith({ dk });
  const s = {};
  await followUpNewApp(ctx, app({ previewPort: 80, env: "" }), s);
  assert.deepEqual(writes, [["application.update", { applicationId: "app1", previewPort: 3000 }]]);
  assert.equal(s.previewPortSynced, true);
  writes.length = 0;
  await followUpNewApp(ctx, app({ previewPort: 80, env: "" }), s);
  assert.equal(writes.length, 0, "not changed again after you edit it");
});

test("previews inherit production env until customised", async () => {
  const { writes, dk } = recorder();
  const ctx = ctxWith({ dk });
  const s = { previewPortSynced: true };
  await followUpNewApp(ctx, app({ env: "A=1", previewEnv: "" }), s);
  assert.deepEqual(writes, [["application.update", { applicationId: "app1", previewEnv: "A=1" }]]);
  writes.length = 0;
  // Production changed and previews were still the copy: follow it.
  await followUpNewApp(ctx, app({ env: "A=2", previewEnv: "A=1" }), s);
  assert.equal(writes[0][1].previewEnv, "A=2");
  writes.length = 0;
  // You customised the preview env: leave it alone.
  await followUpNewApp(ctx, app({ env: "A=3", previewEnv: "A=custom" }), s);
  assert.equal(writes.length, 0);
});

test("only touches previews: never build type or other app settings", async () => {
  const { writes, dk } = recorder();
  await followUpNewApp(ctxWith({ dk }), app({ previewPort: 80, env: "A=1", previewEnv: "" }), {});
  for (const [path, body] of writes) {
    assert.equal(path, "application.update");
    assert.deepEqual(
      Object.keys(body).filter((k) => k !== "applicationId"),
      [Object.keys(body).find((k) => k.startsWith("preview"))],
    );
  }
});

test("switches off, and skips apps not deployed from GitHub", async () => {
  const { writes, dk } = recorder();
  const off = testConfig({ PREVIEW_PORT_SYNC: "false", PREVIEW_ENV_INHERIT: "false" });
  await followUpNewApp(ctxWith({ dk, cfg: off }), app({ previewPort: 80, env: "A=1" }), {});
  await followUpNewApp(
    ctxWith({ dk }),
    app({ sourceType: "git", previewPort: 80, env: "A=1" }),
    {},
  );
  assert.equal(writes.length, 0);
});
