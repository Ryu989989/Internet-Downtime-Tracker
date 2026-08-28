"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  testConnection,
  getClients,
  getRouterHealth,
  setRequestFn,
  resetRequestFn,
} = require("../omada");

afterEach(() => {
  resetRequestFn();
});

function headerOf(init, name) {
  const h = (init && init.headers) || {};
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (String(k).toLowerCase() === want) return String(v);
  }
  return "";
}

const OMADAC = "abc123omadacid";
const SITE = "site99";

const CLIENT_FIXTURE = JSON.stringify({
  errorCode: 0,
  result: {
    data: [
      {
        mac: "AA-BB-CC-DD-EE-01",
        ip: "192.168.0.20",
        hostName: "laptop",
        name: "Work laptop",
        active: true,
        wireless: true,
        rssi: -48,
        signalLevel: 4,
        radioId: 1,
        ssid: "Omada5G",
        txRate: 1201000,
        rxRate: 866000,
        apMac: "11-22-33-44-55-66",
      },
      {
        mac: "AA:BB:CC:DD:EE:02",
        ip: "192.168.0.21",
        name: "printer",
        active: true,
        wireless: false,
        connectType: 2,
      },
    ],
  },
});

function loginOk(handler) {
  return async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/info") {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          errorCode: 0,
          result: { omadacId: OMADAC, controllerVer: "5.13.30.8" },
        }),
      };
    }
    if (u.pathname === `/${OMADAC}/api/v2/login`) {
      assert.equal((init && init.method) || "GET", "POST");
      const body = JSON.parse(String((init && init.body) || "{}"));
      assert.equal(body.username, "admin");
      assert.equal(body.password, "secret");
      return {
        status: 200,
        headers: { "set-cookie": "TPOMADA_SESSIONID=sess; Path=/" },
        body: JSON.stringify({ errorCode: 0, result: { token: "csrf-tok" } }),
      };
    }
    if (u.pathname === `/${OMADAC}/api/v2/sites`) {
      assert.equal(headerOf(init, "csrf-token"), "csrf-tok");
      assert.match(headerOf(init, "cookie"), /TPOMADA_SESSIONID=sess/);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          errorCode: 0,
          result: { data: [{ id: SITE, name: "Default" }] },
        }),
      };
    }
    if (u.pathname === `/${OMADAC}/api/v2/maintenance/controllerStatus`) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          errorCode: 0,
          result: { name: "OC200", controllerVer: "5.13.30.8" },
        }),
      };
    }
    if (handler) return handler(u, init, url);
    throw new Error("unexpected " + u.pathname);
  };
}

describe("omada private-IP reject", () => {
  it("rejects public hosts without HTTP", async () => {
    let calls = 0;
    setRequestFn(async () => {
      calls += 1;
      return { status: 200, headers: {}, body: "" };
    });
    const opts = { host: "8.8.8.8", user: "admin", password: "secret" };
    const a = await testConnection(opts);
    const b = await getClients(opts);
    const c = await getRouterHealth({ host: "1.1.1.1", user: "admin", password: "x" });
    assert.equal(a.ok, false);
    assert.match(a.error, /private or local/i);
    assert.equal(b.ok, false);
    assert.deepEqual(b.clients, []);
    assert.equal(c.ok, false);
    assert.equal(calls, 0);
  });
});

describe("omada login + omadacId", () => {
  it("GETs /api/info then POSTs /{omadacId}/api/v2/login and discovers site", async () => {
    const paths = [];
    const urls = [];
    setRequestFn(async (url, init) => {
      urls.push(url);
      paths.push(new URL(url).pathname);
      return loginOk()(url, init);
    });

    const r = await testConnection({
      host: "192.168.0.2",
      user: "admin",
      password: "secret",
    });
    assert.equal(r.ok, true);
    assert.equal(r.omadacId, OMADAC);
    assert.equal(r.siteId, SITE);
    assert.equal(r.model, "OC200");
    assert.equal(r.firmware, "5.13.30.8");
    assert.deepEqual(paths.slice(0, 3), [
      "/api/info",
      `/${OMADAC}/api/v2/login`,
      `/${OMADAC}/api/v2/sites`,
    ]);
    assert.ok(urls.every((x) => x.startsWith("https://192.168.0.2:8043/")));
  });
});

describe("omada client parse", () => {
  it("maps rssi ssid radioId apMac to NormalizedClient", async () => {
    const r = await getClients({
      host: "10.0.0.1",
      user: "admin",
      password: "secret",
      fetch: loginOk((u) => {
        if (u.pathname === `/${OMADAC}/api/v2/sites/${SITE}/clients`) {
          return { status: 200, headers: {}, body: CLIENT_FIXTURE };
        }
        throw new Error("unexpected " + u.pathname);
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.clients.length, 2);
    const wifi = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:01");
    const wired = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:02");
    assert.equal(wifi.name, "Work laptop");
    assert.equal(wifi.ip, "192.168.0.20");
    assert.equal(wifi.online, true);
    assert.equal(wifi.rssi, -48);
    assert.equal(wifi.signal_pct, 100);
    assert.equal(wifi.band, "5");
    assert.equal(wifi.ssid, "Omada5G");
    assert.equal(wifi.tx_mbps, 1201);
    assert.equal(wifi.rx_mbps, 866);
    assert.equal(wifi.node_mac, "11:22:33:44:55:66");
    assert.equal(wired.band, "wired");
    assert.equal(wired.rssi, null);
    assert.equal(wired.signal_pct, null);
    assert.equal(wired.online, true);
    assert.equal(wired.ssid, null);
    assert.equal(wired.node_mac, null);
  });
});
