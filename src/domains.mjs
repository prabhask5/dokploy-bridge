// Application domains added after this feature first ran:
//  - NEW_DOMAIN_* settings are applied once (HTTPS, certificate, port from the Dockerfile)
//  - an Uptime Kuma monitor is created once the app has deployed
//  - that monitor is deleted when the domain or its app is removed
// Domains that already existed are recorded and left alone, and so are monitors made by hand.
import {
  dockerfilePath,
  exposedPort,
  hasGithubSource,
  hostOf,
  monitorMarkers,
  repoOf,
} from "./util.mjs";

const appDomains = (a) =>
  (a.domains || []).filter(
    (d) => d.domainId && d.host && (d.domainType || "application") === "application",
  );

const hasDeployed = (a) =>
  a.applicationStatus === "done" || (a.deployments || []).some((d) => d.status === "done");

export const hasDomainSettings = (cfg) =>
  cfg.newDomain.https !== undefined ||
  cfg.newDomain.certificate !== undefined ||
  cfg.newDomain.portFromDockerfile;

export const domainsEnabled = (cfg) => Boolean(cfg.kuma.url) || hasDomainSettings(cfg);

// apps: Map of applicationId -> app fetched this tick (not ignored).
// listed: Set of every applicationId project.all returned, ignored apps included.
export async function syncDomains(ctx, apps, listed) {
  const { cfg, log, store } = ctx;
  if (!domainsEnabled(cfg)) return;
  const { state } = store;
  state.domains ||= {};

  if (!state.domainsBaselined) {
    for (const a of apps.values())
      for (const d of appDomains(a))
        state.domains[d.domainId] = { appId: a.applicationId, host: d.host, origin: "existing" };
    state.domainsBaselined = true;
    store.save();
    log.info(`domains: ${Object.keys(state.domains).length} existing domain(s) left as configured`);
    return;
  }

  const kumaWork = [];
  const present = new Set();
  for (const a of apps.values()) {
    for (const d of appDomains(a)) {
      present.add(d.domainId);
      let rec = state.domains[d.domainId];
      if (!rec) {
        rec = state.domains[d.domainId] = {
          appId: a.applicationId,
          host: d.host,
          origin: "new",
          filled: !hasDomainSettings(cfg),
          monitor: cfg.kuma.url ? "pending" : "n/a",
        };
        log.info(`[${a.name}] new domain ${d.host}`);
        store.save();
      }
      if (rec.origin !== "new") continue;
      try {
        if (!rec.filled) await fillDomain(ctx, a, d, rec);
      } catch (e) {
        rec.fillTries = (rec.fillTries || 0) + 1;
        if (rec.fillTries >= 5) {
          rec.filled = true;
          log.info(`[${a.name}] ${d.host}: giving up on NEW_DOMAIN_* settings: ${e.message}`);
        } else log.info(`[${a.name}] ${d.host}: ${e.message}`);
        store.save();
      }
      if (rec.host !== d.host) {
        // Renamed in Dokploy: replace our monitor for the old name.
        if (rec.created && rec.monitorId) kumaWork.push({ kind: "delete", rec: { ...rec }, a });
        Object.assign(rec, { host: d.host, monitorId: undefined, created: undefined });
        if (rec.monitor !== "n/a") rec.monitor = "pending";
        store.save();
      }
      // The monitor waits for the settings above, so it gets the final scheme and port.
      if (cfg.kuma.url && rec.monitor === "pending" && rec.filled && hasDeployed(a))
        kumaWork.push({ kind: "create", rec, a, d });
    }
  }

  // A domain is gone when its app was read this tick without it, or the app itself is gone.
  // Apps that failed to load or are ignored keep their records until we know more.
  const removed = Object.entries(state.domains).filter(
    ([id, rec]) => !present.has(id) && (apps.has(rec.appId) || !listed.has(rec.appId)),
  );
  const deletes = removed.filter(([, rec]) => rec.created && rec.monitorId);
  if (cfg.kuma.url && deletes.length > cfg.kuma.maxDeletes) {
    log.once(
      `kuma-cap-${deletes.length}`,
      `domains: ${deletes.length} monitors would be deleted at once, more than KUMA_MAX_DELETES_PER_TICK (${cfg.kuma.maxDeletes}); not deleting any. Raise the limit if this is intended.`,
    );
  } else {
    for (const [id, rec] of removed) {
      if (cfg.kuma.url && rec.created && rec.monitorId) kumaWork.push({ kind: "delete", rec, id });
      else {
        delete state.domains[id];
        store.save();
      }
    }
  }

  if (!kumaWork.length) return;
  const { kuma } = ctx;
  if (!kuma) return;
  try {
    await kuma.connect();
    for (const w of kumaWork) {
      const label = w.a ? `[${w.a.name}] ` : "";
      try {
        if (w.kind === "create") await createMonitor(ctx, kuma, w.a, w.d, w.rec);
        else {
          await kuma.call("deleteMonitor", w.rec.monitorId);
          log.info(`${label}monitor for ${w.rec.host} deleted`);
          if (w.id) delete state.domains[w.id];
        }
        store.save();
      } catch (e) {
        log.info(`${label}${w.rec.host}: ${e.message}`);
      }
    }
  } catch (e) {
    log.info(`uptime monitors: ${e.message}`);
  } finally {
    kuma.close();
  }
}

async function fillDomain(ctx, a, d, rec) {
  const { cfg, log, dk, gh, store } = ctx;
  const nd = cfg.newDomain;
  const patch = {};
  if (nd.portFromDockerfile && a.buildType === "dockerfile") {
    // Wait for the repository: the domain is often added before it's connected.
    if (!hasGithubSource(a)) return;
    const path = dockerfilePath(a);
    const file = await gh(
      a.githubId,
      "GET",
      `/repos/${repoOf(a)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(a.branch || "")}`,
    );
    const port = exposedPort(
      Buffer.from(file?.content || "", "base64").toString("utf8"),
      a.dockerBuildStage,
    );
    if (port && port !== d.port) patch.port = port;
    else if (!port) log.debug(`[${a.name}] no EXPOSE in ${path}; domain port left at ${d.port}`);
  }
  if (nd.https !== undefined && d.https !== nd.https) patch.https = nd.https;
  if (nd.certificate !== undefined && d.certificateType !== nd.certificate)
    patch.certificateType = nd.certificate;
  if (Object.keys(patch).length) {
    await dk("POST", "domain.update", domainUpdate(d, patch));
    Object.assign(d, patch);
    log.info(
      `[${a.name}] ${d.host}: ${Object.entries(patch)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
    // The preview port follows the first domain; let it follow the corrected port.
    if (patch.port && ctx.store.state.apps[a.applicationId])
      ctx.store.state.apps[a.applicationId].previewPortSynced = false;
  }
  rec.filled = true;
  store.save();
}

// domain.update validates the whole domain, not just the fields being changed: host and
// customCertResolver are required, and https needs a certificate type. So the domain's
// current values go along with the patch.
export function domainUpdate(d, patch) {
  const next = { ...d, ...patch };
  const body = {
    domainId: d.domainId,
    host: next.host,
    path: next.path,
    port: next.port,
    https: next.https,
    certificateType: next.certificateType || (next.https ? "none" : undefined),
    customCertResolver: next.customCertResolver ?? "",
    internalPath: next.internalPath,
    stripPath: next.stripPath,
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

export function monitorFor(cfg, a, d, notifications) {
  const k = cfg.kuma;
  const m = monitorMarkers(a.description);
  const others = appDomains(a);
  const base = m.name || a.name;
  const name =
    others[0]?.domainId === d.domainId || others.length < 2 ? base : `${base} (${d.host})`;
  const wanted = k.notifications.length
    ? notifications.filter((n) => k.notifications.includes(n.name))
    : notifications.filter((n) => n.isDefault);
  const path = d.path && d.path !== "/" ? d.path.replace(/\/+$/, "") : "";
  return {
    // Kuma's own defaults for a new monitor, as its UI sends them.
    type: m.keyword ? "keyword" : "http",
    name,
    parent: null,
    url: `${d.https === false ? "http" : "https"}://${d.host}${path}${m.health || ""}`,
    method: "GET",
    interval: k.interval,
    retryInterval: k.retryInterval,
    resendInterval: k.resend,
    maxretries: k.retries,
    timeout: k.timeout,
    notificationIDList: Object.fromEntries(wanted.map((n) => [n.id, true])),
    ignoreTls: false,
    upsideDown: false,
    packetSize: 56,
    expiryNotification: k.expiryNotification,
    maxredirects: k.maxRedirects,
    accepted_statuscodes: k.acceptedStatus,
    dns_resolve_type: "A",
    dns_resolve_server: "1.1.1.1",
    docker_container: "",
    docker_host: null,
    proxyId: null,
    mqttUsername: "",
    mqttPassword: "",
    mqttTopic: "",
    mqttSuccessMessage: "",
    authMethod: null,
    oauth_auth_method: "client_secret_basic",
    httpBodyEncoding: "json",
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    gamedigGivenPortOnly: true,
    keyword: m.keyword || "",
    invertKeyword: false,
    description: `Created by dokploy-bridge for ${a.name}; deleted when ${d.host} is removed from it.`,
  };
}

async function createMonitor(ctx, kuma, a, d, rec) {
  const { cfg, log } = ctx;
  const markers = monitorMarkers(a.description);
  if (markers.off) return;
  // A monitor you made yourself for this host is used as it is, and never deleted.
  const mine = kuma.monitors().find((m) => hostOf(m.url) === d.host.toLowerCase());
  if (mine) {
    Object.assign(rec, { monitor: "done", monitorId: mine.id, created: false });
    log.info(`[${a.name}] ${d.host} already has monitor "${mine.name}"; leaving it as it is`);
    return;
  }
  const monitor = monitorFor(cfg, a, d, kuma.notifications());
  const res = await kuma.call("add", monitor);
  Object.assign(rec, {
    monitor: "done",
    monitorId: res.monitorID,
    created: true,
    name: monitor.name,
  });
  ctx.store.save();
  log.info(`[${a.name}] monitor "${monitor.name}" created for ${monitor.url}`);
}
