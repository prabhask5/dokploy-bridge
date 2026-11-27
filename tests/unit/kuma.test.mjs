import { test } from "node:test";
import assert from "node:assert/strict";
import { createKuma } from "../../src/kuma.mjs";
import { testConfig, recordingLog } from "../support/helpers.mjs";

const cfgWith = (env = {}) =>
  testConfig({ KUMA_URL: "http://kuma:3001", KUMA_USERNAME: "u", KUMA_PASSWORD: "p", ...env });

// Plays an Uptime Kuma server speaking Socket.IO (Engine.IO v4) frames.
function fakeServer({ login = { ok: true }, answers = {} } = {}) {
  const seen = { url: null, sent: [], events: [] };
  class FakeWS {
    constructor(url) {
      seen.url = url;
      seen.ws = this;
      setTimeout(() => this.push('0{"sid":"x","pingInterval":25000}'));
    }
    push(data) {
      this.onmessage?.({ data });
    }
    send(frame) {
      seen.sent.push(frame);
      if (frame === "40") return this.push('40{"sid":"y"}');
      const m = /^42(\d+)(\[.*)$/s.exec(frame);
      if (!m) return;
      const [event, ...args] = JSON.parse(m[2]);
      seen.events.push([event, ...args]);
      const reply = event === "login" ? login : (answers[event] ?? { ok: true });
      this.push(`43${m[1]}${JSON.stringify([reply])}`);
      if (event === "login" && login.ok) {
        this.push('42["monitorList",{"7":{"id":7,"name":"Site","url":"https://a.example.com"}}]');
        this.push('42["notificationList",[{"id":1,"name":"Email","isDefault":true}]]');
      }
    }
    close() {
      seen.closed = true;
    }
  }
  return { FakeWS, seen };
}

test("logs in over Socket.IO and keeps the monitor and notification lists", async () => {
  const { FakeWS, seen } = fakeServer();
  const kuma = createKuma({ cfg: cfgWith(), log: recordingLog(), WebSocketImpl: FakeWS });
  await kuma.connect();
  assert.equal(seen.url, "ws://kuma:3001/socket.io/?EIO=4&transport=websocket");
  assert.deepEqual(seen.events[0], ["login", { username: "u", password: "p", token: "" }]);
  assert.deepEqual(
    kuma.monitors().map((m) => m.id),
    [7],
  );
  assert.equal(kuma.notifications()[0].name, "Email");

  seen.ws.push("2");
  assert.equal(seen.sent.at(-1), "3", "answers pings");

  kuma.close();
  assert.ok(seen.closed);
});

test("calls wait for their ack and fail on ok: false", async () => {
  const { FakeWS } = fakeServer({
    answers: { add: { ok: true, monitorID: 42 }, deleteMonitor: { ok: false, msg: "nope" } },
  });
  const kuma = createKuma({ cfg: cfgWith(), log: recordingLog(), WebSocketImpl: FakeWS });
  await kuma.connect();
  assert.equal((await kuma.call("add", { name: "x" })).monitorID, 42);
  await assert.rejects(kuma.call("deleteMonitor", 1), /deleteMonitor: nope/);
});

test("a bad login or 2FA is an error that names the fix", async () => {
  const bad = fakeServer({ login: { ok: false, msg: "Incorrect username or password." } });
  const k1 = createKuma({ cfg: cfgWith(), log: recordingLog(), WebSocketImpl: bad.FakeWS });
  await assert.rejects(k1.connect(), /login failed: Incorrect/);

  const tfa = fakeServer({ login: { tokenRequired: true } });
  const k2 = createKuma({ cfg: cfgWith(), log: recordingLog(), WebSocketImpl: tfa.FakeWS });
  await assert.rejects(k2.connect(), /2FA/);
});

test("DRY_RUN logs writes instead of sending them; reads still go through", async () => {
  const { FakeWS, seen } = fakeServer({ answers: { getStatusPage: { ok: true, config: {} } } });
  const log = recordingLog();
  const kuma = createKuma({ cfg: cfgWith({ DRY_RUN: "true" }), log, WebSocketImpl: FakeWS });
  await kuma.connect();
  const res = await kuma.call("add", { name: "Planner" });
  assert.ok(res.monitorID < 0);
  await kuma.call("deleteMonitor", 3);
  await kuma.call("saveStatusPage", "moi", {}, "", []);
  await kuma.call("getStatusPage", "moi");
  assert.deepEqual(
    seen.events.map((e) => e[0]),
    ["login", "getStatusPage"],
  );
  assert.match(log.lines.join("\n"), /\[dry-run\] Kuma add Planner/);
});

test("status page groups come from Kuma's public status page endpoint", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ publicGroupList: [{ id: 1, name: "Apps" }] }) };
  };
  const kuma = createKuma({ cfg: cfgWith(), log: recordingLog(), fetchImpl });
  assert.deepEqual(await kuma.statusPageGroups("moi"), [{ id: 1, name: "Apps" }]);
  assert.deepEqual(urls, ["http://kuma:3001/api/status-page/moi"]);
});
