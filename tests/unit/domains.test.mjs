import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncDomains, monitorFor } from "../../src/domains.mjs";
import { tick } from "../../src/index.mjs";
import { ctxWith, testConfig, memoryStore, fakeGitHub, app } from "../support/helpers.mjs";

const KUMA = {
  KUMA_URL: "http://kuma:3001",
  KUMA_USERNAME: "bridge",
  KUMA_PASSWORD: "secret",
  KUMA_STATUS_PAGE: "moi",
  KUMA_STATUS_GROUP: "Applications",
};
const DOMAINS = {
  NEW_DOMAIN_HTTPS: "true",
  NEW_DOMAIN_CERTIFICATE: "none",
  NEW_DOMAIN_PORT_FROM_DOCKERFILE: "true",
};

// A fake Kuma: monitors, notifications and one status page, with a log of every call.
function fakeKuma({ monitors = [], groups } = {}) {
  const db = {
    monitors: [...monitors],
    notifications: [
      { id: 1, name: "Email", isDefault: true },
      { id: 2, name: "Pager", isDefault: false },
    ],
    groups: groups || [
      {
        id: 10,
        name: "Applications",
        monitorList: [
          { id: 1, name: "Compiler", sendUrl: 0 },
          { id: 2, name: "Stellar Planner", sendUrl: 1 },
        ],
      },
      { id: 11, name: "Infrastructure", monitorList: [{ id: 3, name: "AdGuard", sendUrl: 0 }] },
    ],
    calls: [],
    connects: 0,
  };
  // Every monitor on the page exists in Kuma too.
  for (const m of db.groups.flatMap((g) => g.monitorList))
    if (!db.monitors.some((x) => x.id === m.id))
      db.monitors.push({ id: m.id, name: m.name, url: `https://m${m.id}.example.org` });
  let next = 50;
  const kuma = {
    async connect() {
      db.connects++;
    },
    close() {},
    monitors: () => db.monitors,
    notifications: () => db.notifications,
    statusPageGroups: async () => structuredClone(db.groups),
    async call(event, ...args) {
      db.calls.push([event, ...args]);
      if (event === "add") {
        const id = next++;
        db.monitors.push({ id, ...args[0] });
        return { ok: true, monitorID: id };
      }
      if (event === "deleteMonitor") {
        db.monitors = db.monitors.filter((m) => m.id !== args[0]);
        return { ok: true };
      }
      if (event === "getStatusPage")
        return { ok: true, config: { slug: args[0], title: "moi", icon: "/upload/logo1.png" } };
      if (event === "saveStatusPage") {
        const names = new Map(db.monitors.map((m) => [m.id, m.name]));
        db.groups = args[3].map((g) => ({
          ...g,
          monitorList: g.monitorList.map((m) => ({ ...m, name: names.get(m.id) })),
        }));
        return { ok: true };
      }
      throw new Error(`fake Kuma: unhandled ${event}`);
    },
  };
  return { kuma, db };
}

function dokploy() {
  const writes = [];
  const dk = async (method, p, body) => {
    if (method === "POST") writes.push([p, body]);
    return null;
  };
  return { writes, dk };
}

const dockerfile = "FROM node:24 AS build\nEXPOSE 9999\nFROM node:24-alpine\nEXPOSE 8080/tcp\n";
const gh = async (_id, method, p) => {
  if (method === "GET" && p.startsWith("/repos/me/stellar/contents/apps/web/Dockerfile?ref=main"))
    return { content: Buffer.from(dockerfile).toString("base64") };
  throw new Error(`unexpected GitHub ${method} ${p}`);
};

const stellar = (over = {}) =>
  app({
    applicationId: "st",
    name: "stellar",
    repository: "stellar",
    buildType: "dockerfile",
    buildPath: "/apps/web",
    dockerfile: "Dockerfile",
    description: "Planner\nmonitor: Stellar\nhealth: api/health\nkeyword: ok",
    domains: [],
    ...over,
  });
const dom = (over = {}) => ({
  domainId: "d1",
  host: "planner.example.com",
  https: true,
  port: 3000,
  path: "/",
  certificateType: "none",
  domainType: "application",
  ...over,
});

function setup(env = { ...KUMA, ...DOMAINS }, kumaOpts) {
  const { writes, dk } = dokploy();
  const { kuma, db } = fakeKuma(kumaOpts);
  const ctx = ctxWith({ dk, gh, cfg: testConfig(env), store: memoryStore() });
  ctx.kuma = kuma;
  const run = (apps, listed = apps.map((a) => a.applicationId)) =>
    syncDomains(ctx, new Map(apps.map((a) => [a.applicationId, a])), new Set(listed));
  return { ctx, writes, db, run, state: ctx.store.state };
}

test("the first run records existing domains and changes nothing", async () => {
  const { run, writes, db, state } = setup();
  await run([stellar({ domains: [dom()] })]);
  assert.equal(state.domains.d1.origin, "existing");
  assert.deepEqual(writes, []);
  assert.deepEqual(db.calls, []);
  // Later ticks leave it alone too.
  await run([stellar({ domains: [dom()] })]);
  assert.deepEqual(writes, []);
  assert.deepEqual(db.calls, []);
});

test("a new domain gets HTTPS, the certificate and the Dockerfile's port, once", async () => {
  const { run, writes, state, ctx } = setup();
  await run([stellar()]);
  ctx.store.state.apps.st = { previewPortSynced: true };
  await run([stellar({ domains: [dom({ https: false, certificateType: "letsencrypt" })] })]);
  assert.deepEqual(writes, [
    ["domain.update", { domainId: "d1", port: 8080, https: true, certificateType: "none" }],
  ]);
  assert.equal(state.domains.d1.filled, true);
  assert.equal(state.apps.st.previewPortSynced, false, "the preview port follows the new port");
  await run([stellar({ domains: [dom()] })]);
  assert.equal(writes.length, 1, "applied once, even if changed back by hand");
});

test("a build stage named by Dokploy is where the port comes from", async () => {
  const { run, writes } = setup();
  await run([stellar()]);
  await run([stellar({ dockerBuildStage: "build", domains: [dom()] })]);
  assert.equal(writes[0][1].port, 9999);
});

test("the port waits for the repository to be connected", async () => {
  const { run, writes } = setup();
  await run([stellar()]);
  await run([stellar({ githubId: null, domains: [dom()] })]);
  assert.deepEqual(writes, []);
  await run([stellar({ domains: [dom()] })]);
  assert.equal(writes[0][1].port, 8080);
});

test("without NEW_DOMAIN_* settings domains are never updated", async () => {
  const { run, writes } = setup({ ...KUMA });
  await run([stellar()]);
  await run([stellar({ domains: [dom()] })]);
  assert.deepEqual(writes, []);
});

test("a monitor waits for the first successful deploy, then joins the group alphabetically", async () => {
  const { run, db, state } = setup();
  await run([stellar()]);
  await run([stellar({ applicationStatus: "idle", domains: [dom()] })]);
  assert.equal(db.connects, 0, "no monitor for an app that isn't up yet");

  await run([stellar({ domains: [dom()] })]);
  const add = db.calls.find((c) => c[0] === "add")[1];
  assert.equal(add.name, "Stellar");
  assert.equal(add.type, "keyword");
  assert.equal(add.keyword, "ok");
  assert.equal(add.url, "https://planner.example.com/api/health");
  assert.deepEqual(add.notificationIDList, { 1: true });
  assert.deepEqual(add.accepted_statuscodes, ["200-299"]);
  assert.equal(add.maxretries, 2);
  assert.equal(add.retryInterval, 20);
  assert.equal(add.expiryNotification, true);

  const save = db.calls.find((c) => c[0] === "saveStatusPage");
  assert.equal(save[1], "moi");
  assert.equal(save[3], "/upload/logo1.png", "the logo is kept");
  assert.deepEqual(
    db.groups[0].monitorList.map((m) => m.name),
    ["Compiler", "Stellar", "Stellar Planner"],
  );
  assert.deepEqual(db.groups[0].monitorList[2], { id: 2, sendUrl: 1, name: "Stellar Planner" });
  assert.deepEqual(
    db.groups[1].monitorList.map((m) => m.id),
    [3],
    "other groups are kept",
  );
  assert.equal(state.domains.d1.created, true);
  assert.equal(state.domains.d1.listed, true);

  await run([stellar({ domains: [dom()] })]);
  assert.equal(db.calls.filter((c) => c[0] === "add").length, 1, "created once");
});

test("without markers the monitor is a plain HTTP check named after the app", async () => {
  const { run, db } = setup({ ...KUMA, KUMA_MONITOR_NOTIFICATIONS: "Pager" });
  await run([stellar()]);
  await run([stellar({ description: "", domains: [dom({ https: true })] })]);
  const add = db.calls.find((c) => c[0] === "add")[1];
  assert.equal(add.name, "stellar");
  assert.equal(add.type, "http");
  assert.equal(add.url, "https://planner.example.com");
  assert.deepEqual(add.notificationIDList, { 2: true });
  assert.equal(db.groups[0].monitorList[1].name, "stellar", "sorted case-insensitively");
});

test("a second domain's monitor carries its host", () => {
  const cfg = testConfig(KUMA);
  const a = stellar({ domains: [dom(), dom({ domainId: "d2", host: "p2.example.com" })] });
  assert.equal(monitorFor(cfg, a, a.domains[0], []).name, "Stellar");
  assert.equal(monitorFor(cfg, a, a.domains[1], []).name, "Stellar (p2.example.com)");
});

test("monitor: off, preview domains and a missing KUMA_URL create nothing", async () => {
  const off = setup();
  await off.run([stellar()]);
  await off.run([stellar({ description: "monitor: off", domains: [dom()] })]);
  assert.equal(off.db.calls.length, 0);

  const prev = setup();
  await prev.run([stellar()]);
  await prev.run([stellar({ domains: [dom({ domainType: "preview" })] })]);
  assert.equal(prev.db.connects, 0);
  assert.deepEqual(prev.state.domains, {});

  const noKuma = setup({ ...DOMAINS });
  await noKuma.run([stellar()]);
  await noKuma.run([stellar({ domains: [dom()] })]);
  assert.equal(noKuma.db.connects, 0);
  assert.equal(noKuma.state.domains.d1.monitor, "n/a");
});

test("a monitor you made for the host is used and never deleted", async () => {
  const mine = { id: 2, name: "Stellar Planner", url: "https://planner.example.com/api/health" };
  const { run, db, state } = setup(undefined, { monitors: [mine] });
  await run([stellar()]);
  await run([stellar({ domains: [dom()] })]);
  assert.equal(db.calls.filter((c) => c[0] === "add").length, 0);
  assert.equal(state.domains.d1.monitorId, 2);
  await run([stellar({ domains: [] })]);
  assert.equal(db.calls.filter((c) => c[0] === "deleteMonitor").length, 0);
  assert.equal(state.domains.d1, undefined);
});

test("removing the domain or the app deletes the monitor; a failed read doesn't", async () => {
  const { run, db, state } = setup();
  await run([stellar()]);
  await run([stellar({ domains: [dom()] })]);
  const id = state.domains.d1.monitorId;

  // The app couldn't be read this tick but is still listed: keep everything.
  await run([], ["st"]);
  assert.ok(state.domains.d1);

  // The domain was removed from the app.
  await run([stellar({ domains: [] })]);
  assert.deepEqual(
    db.calls.filter((c) => c[0] === "deleteMonitor"),
    [["deleteMonitor", id]],
  );
  assert.equal(state.domains.d1, undefined);

  // The whole app was deleted.
  await run([stellar({ domains: [dom({ domainId: "d2" })] })]);
  await run([]);
  assert.equal(db.calls.filter((c) => c[0] === "deleteMonitor").length, 2);
  assert.deepEqual(state.domains, {});
});

test("more deletions than KUMA_MAX_DELETES_PER_TICK deletes none", async () => {
  const { run, db, state, ctx } = setup({ ...KUMA, KUMA_MAX_DELETES_PER_TICK: "1" });
  const two = [dom(), dom({ domainId: "d2", host: "p2.example.com" })];
  await run([stellar()]);
  await run([stellar({ domains: two })]);
  await run([]);
  assert.equal(db.calls.filter((c) => c[0] === "deleteMonitor").length, 0);
  assert.equal(Object.keys(state.domains).length, 2);
  assert.match(ctx.log.lines.join("\n"), /more than KUMA_MAX_DELETES_PER_TICK/);
});

test("a renamed domain gets a new monitor in place of ours", async () => {
  const { run, db, state } = setup();
  await run([stellar()]);
  await run([stellar({ domains: [dom()] })]);
  const old = state.domains.d1.monitorId;
  await run([stellar({ domains: [dom({ host: "plan.example.com" })] })]);
  assert.deepEqual(
    db.calls.filter((c) => c[0] === "deleteMonitor"),
    [["deleteMonitor", old]],
  );
  assert.equal(
    db.monitors.find((m) => m.id === state.domains.d1.monitorId).url,
    "https://plan.example.com/api/health",
  );
});

test("a status page without the group is reported once and retried", async () => {
  const { run, db, state, ctx } = setup(undefined, {
    groups: [{ id: 10, name: "Services", monitorList: [] }],
  });
  await run([stellar()]);
  await run([stellar({ domains: [dom()] })]);
  await run([stellar({ domains: [dom()] })]);
  assert.equal(db.calls.filter((c) => c[0] === "saveStatusPage").length, 0);
  assert.equal(state.domains.d1.listed, false);
  assert.equal(ctx.log.lines.filter((l) => /has no group "Applications"/.test(l)).length, 1);
  assert.equal(db.calls.filter((c) => c[0] === "getStatusPage").length, 2, "retried next tick");
});

test("a monitor deleted since the page was cached isn't sent back", async () => {
  const { run, db } = setup();
  db.monitors = db.monitors.filter((m) => m.id !== 1); // "Compiler" deleted in Kuma
  await run([stellar()]);
  await run([stellar({ domains: [dom()] })]);
  const sent = db.calls.find((c) => c[0] === "saveStatusPage")[4];
  assert.deepEqual(
    sent[0].monitorList.map((m) => m.id),
    [50, 2],
  );
});

test("a tick leaves the monitors of apps that are ignored or fail to load", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
  let apps = {
    st: stellar({ domains: [dom()] }),
    off: stellar({ applicationId: "off", name: "off", domains: [dom({ domainId: "d2" })] }),
  };
  const dk = async (method, p) => {
    if (p === "project.all")
      return [
        { environments: [{ applications: Object.values(apps).map(({ domains: _d, ...a }) => a) }] },
      ];
    if (p.startsWith("application.one")) {
      const a = apps[new URLSearchParams(p.split("?")[1]).get("applicationId")];
      if (!a || a.applicationId === "st") throw new Error("Dokploy hiccup");
      return a;
    }
    if (p.startsWith("previewDeployment.all")) return [];
    return null;
  };
  const { kuma, db } = fakeKuma();
  const store = memoryStore({ domainsBaselined: true });
  const cfg = testConfig({ ...KUMA, HEARTBEAT_FILE: path.join(dir, "hb") });
  const ctx = ctxWith({ dk, gh: fakeGitHub().gh, store, cfg });
  ctx.kuma = kuma;
  store.state.domains = {
    d1: { appId: "st", host: "planner.example.com", origin: "new", monitorId: 2, created: true },
    d2: { appId: "off", host: "planner.example.com", origin: "new", monitorId: 3, created: true },
  };
  apps.off.description = "dokploy-bridge: off";
  await tick(ctx);
  assert.deepEqual(Object.keys(store.state.domains), ["d1", "d2"]);
  assert.equal(db.calls.length, 0);
  apps = {};
  await tick(ctx);
  assert.deepEqual(store.state.domains, {}, "both apps deleted: their monitors go");
});
