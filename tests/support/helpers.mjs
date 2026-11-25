// Test doubles: an in-memory store, a recording logger, and scriptable Dokploy/GitHub clients.
import { loadConfig } from "../../src/config.mjs";
import { HttpError } from "../../src/clients.mjs";

export function testConfig(env = {}) {
  const { cfg } = loadConfig({ DOKPLOY_API_KEY: "test", DATA_DIR: "/nonexistent", ...env });
  return cfg;
}

export function memoryStore(initial = {}) {
  const state = { baselined: true, apps: {}, reported: {}, previews: {}, pending: {}, ...initial };
  return { state, save() {} };
}

export function recordingLog() {
  const lines = [];
  const seen = new Set();
  return {
    lines,
    info: (...a) => lines.push(a.join(" ")),
    debug: () => {},
    once: (k, ...a) => {
      if (!seen.has(k)) {
        seen.add(k);
        lines.push(a.join(" "));
      }
    },
  };
}

// A fake GitHub: deployments per repo, check runs, statuses, environments, and a call log.
export function fakeGitHub({ forbid = [] } = {}) {
  let nextId = 100;
  const db = { deployments: [], checks: [], statuses: [], envs: new Set(), calls: [] };
  const deny = (method, path) => forbid.some(([m, re]) => m === method && re.test(path));
  async function gh(_githubId, method, path, body) {
    db.calls.push(`${method} ${path}`);
    if (deny(method, path))
      throw new HttpError(
        `GitHub ${method} ${path} -> 403 Resource not accessible by integration`,
        403,
      );
    let m;
    if (method === "POST" && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/deployments$/))) {
      const d = {
        id: nextId++,
        repo: m[1],
        environment: body.environment,
        ref: body.ref,
        statuses: [],
      };
      db.deployments.push(d);
      db.envs.add(`${m[1]}|${body.environment}`);
      return { id: d.id };
    }
    if (method === "POST" && (m = path.match(/\/deployments\/(\d+)\/statuses$/))) {
      const d = db.deployments.find((x) => x.id === Number(m[1]));
      if (!d) throw new HttpError("404", 404);
      d.statuses.push(body.state);
      return {};
    }
    if (method === "GET" && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/deployments\?(.*)$/))) {
      const q = new URLSearchParams(m[2]);
      const env = q.get("environment");
      const page = Number(q.get("page") || 1),
        per = Number(q.get("per_page") || 30);
      const all = db.deployments.filter((d) => d.repo === m[1] && (!env || d.environment === env));
      return all
        .slice((page - 1) * per, page * per)
        .map(({ id, environment }) => ({ id, environment }));
    }
    if (method === "GET" && (m = path.match(/\/deployments\/(\d+)$/))) {
      const d = db.deployments.find((x) => x.id === Number(m[1]));
      if (!d) throw new HttpError("404", 404);
      return { id: d.id, environment: d.environment };
    }
    if (method === "DELETE" && (m = path.match(/\/deployments\/(\d+)$/))) {
      db.deployments = db.deployments.filter((x) => x.id !== Number(m[1]));
      return null;
    }
    if (method === "DELETE" && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/environments\/(.+)$/))) {
      const key = `${m[1]}|${decodeURIComponent(m[2])}`;
      if (!db.envs.delete(key)) throw new HttpError("404", 404);
      return null;
    }
    if (method === "POST" && path.endsWith("/check-runs")) {
      const c = { id: nextId++, ...body };
      db.checks.push(c);
      return { id: c.id };
    }
    if (method === "PATCH" && (m = path.match(/\/check-runs\/(\d+)$/))) {
      const c = db.checks.find((x) => x.id === Number(m[1]));
      Object.assign(c, body);
      return {};
    }
    if (method === "POST" && (m = path.match(/\/statuses\/([0-9a-f]+)$/))) {
      db.statuses.push({ sha: m[1], ...body });
      return {};
    }
    if (method === "GET" && (m = path.match(/\/pulls\/(\d+)$/)))
      return { head: { sha: db.prHeads?.[m[1]] || "f".repeat(40) } };
    if (method === "GET" && path.includes("/commits/"))
      return { sha: db.branchHead || "e".repeat(40) };
    throw new Error(`fake GitHub: unhandled ${method} ${path}`);
  }
  return { gh, db };
}

export function ctxWith({
  cfg = testConfig(),
  store = memoryStore(),
  gh,
  dk = async () => [],
} = {}) {
  return {
    cfg,
    log: recordingLog(),
    store,
    gh,
    dk,
    flags: { checksUnavailable: false },
    swept: new Set(),
  };
}

export const SHA = "abc1234def5678abc1234def5678abc1234def56";
export const app = (over = {}) => ({
  applicationId: "app1",
  name: "shortless",
  appName: "shortless-x1",
  sourceType: "github",
  githubId: "gh1",
  owner: "me",
  repository: "shortless",
  branch: "main",
  applicationStatus: "done",
  domains: [{ host: "shortless.example.com", https: true, port: 3000 }],
  deployments: [],
  ...over,
});
