// A minimal Uptime Kuma client. Kuma (1.x) has no REST API for monitors or status pages; its own
// UI does everything over Socket.IO, so this speaks just enough of that protocol (Engine.IO v4
// frames over a WebSocket) to log in and add and delete monitors.
//
// Frames: "0{…}" open, "40" connect, "2"/"3" ping/pong, "42[event, …]" event,
// "42<id>[event, …]" event expecting an ack, "43<id>[result]" the ack.
// Reads go through even in DRY_RUN; add and deleteMonitor are only logged.

const WRITES = new Set(["add", "deleteMonitor"]);

export function createKuma({ cfg, log, WebSocketImpl = globalThis.WebSocket }) {
  const base = cfg.kuma.url;
  let ws = null;
  let nextId = 0;
  let fakeId = 0;
  const acks = new Map();
  const events = new Map(); // latest payload of each server-pushed event
  const waiters = [];

  const onEvent = (name, payload) => {
    events.set(name, payload);
    for (const w of waiters.splice(0)) {
      if (w.name === name) w.resolve(payload);
      else waiters.push(w);
    }
  };
  const waitFor = (name, ms = 10000) =>
    events.has(name)
      ? Promise.resolve(events.get(name))
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`Kuma did not send ${name}`)), ms);
          waiters.push({ name, resolve: (v) => (clearTimeout(t), resolve(v)) });
        });

  function onMessage(sock, raw) {
    const data = String(raw);
    if (data === "2") return sock.send("3");
    if (data.startsWith("0")) return sock.send("40");
    if (data.startsWith("40")) return onEvent("_connected", true);
    const m = /^4([23])(\d*)(\[.*)$/s.exec(data);
    if (!m) return;
    const [, kind, id, json] = m;
    const arr = JSON.parse(json);
    if (kind === "3") {
      const a = acks.get(Number(id));
      if (a) {
        acks.delete(Number(id));
        a.resolve(arr[0]);
      }
    } else onEvent(arr[0], arr[1]);
  }

  function emit(event, ...args) {
    if (cfg.dryRun && WRITES.has(event)) {
      log.info(`[dry-run] Kuma ${event} ${event === "add" ? args[0].name : (args[0] ?? "")}`);
      return Promise.resolve(event === "add" ? { ok: true, monitorID: --fakeId } : { ok: true });
    }
    if (!ws) return Promise.resolve({ ok: false, msg: "not connected" });
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        acks.delete(id);
        reject(new Error(`Kuma ${event}: no answer`));
      }, 20000);
      acks.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)) });
      ws.send(`42${id}${JSON.stringify([event, ...args])}`);
    });
  }

  async function call(event, ...args) {
    const res = await emit(event, ...args);
    if (res && res.ok === false) throw new Error(`Kuma ${event}: ${res.msg || "failed"}`);
    return res;
  }

  async function connect() {
    if (ws) return;
    const url = `${base.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
    const sock = (ws = new WebSocketImpl(url));
    sock.onmessage = (e) => onMessage(sock, e.data);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      events.clear();
      for (const a of acks.values()) a.resolve({ ok: false, msg: "connection closed" });
      acks.clear();
    };
    try {
      await new Promise((resolve, reject) => {
        sock.onerror = () => reject(new Error(`cannot reach Uptime Kuma at ${base}`));
        waitFor("_connected").then(resolve, reject);
      });
      const res = await emit("login", {
        username: cfg.kuma.username,
        password: cfg.kuma.password,
        token: "",
      });
      if (res?.tokenRequired) throw new Error("the Kuma user has 2FA on: use a user without 2FA");
      if (!res?.ok) throw new Error(`Kuma login failed: ${res?.msg || "unknown error"}`);
      await Promise.all([waitFor("monitorList"), waitFor("notificationList")]);
    } catch (e) {
      close();
      throw e;
    }
  }

  function close() {
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    ws = null;
    events.clear();
  }

  return {
    connect,
    close,
    call,
    monitors: () => Object.values(events.get("monitorList") || {}),
    notifications: () => Object.values(events.get("notificationList") || {}),
  };
}
