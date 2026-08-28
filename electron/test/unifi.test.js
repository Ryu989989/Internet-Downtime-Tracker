"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  testConnection,
  getClients,
  getRouterHealth,
  setRequestFn,
  resetRequestFn,
} = require("../unifi");

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

const STA_FIXTURE = JSON.stringify({
  meta: { rc: "ok" },
  data: [
    {
      mac: "aa:bb:cc:dd:ee:01",
      ip: "192.168.1.20",
      hostname: "laptop",
      name: "Work laptop",
      is_wired: false,
      rssi: -48,
      essid: "Home5G",
      radio: "na",
      ap_mac: "11:22:33:44:55:66",
      tx_rate: 1201000,
      rx_rate: 866000,
    },
    {
      mac: "aa:bb:cc:dd:ee:02",
      ip: "192.168.1.21",
      hostname: "printer",
      is_wired: true,
    },
  ],
});

describe("unifi private-IP reject", () => {
  it("rejects public hosts without HTTP", async () => {
    let calls = 0;
    setRequestFn(async () => {
      calls += 1;
      return { status: 200, headers: {}, body: "" };
    });
    const opts = { host: "8.8.8.8", user: "admin", password: "secret" };
    const a = await testConnection(opts);
    const b = await getClients(opts);
    const c = await getRouterHealth({ host: "1.1.1.1", api_key: "secret-key" });
    assert.equal(a.ok, false);
    assert.match(a.error, /private or local/i);
    assert.equal(b.ok, false);
    assert.deepEqual(b.clients, []);
    assert.equal(c.ok, false);
    assert.equal(calls, 0);
  });
});

describe("unifi API key", () => {
  it("sends X-API-KEY on UniFi OS sta path", async () => {
    const paths = [];
    setRequestFn(async (url, init) => {
      paths.push(new URL(url).pathname);
      assert.equal(headerOf(init, "x-api-key"), "unitest-key");
      assert.equal(headerOf(init, "cookie"), "");
      return { status: 200, headers: {}, body: STA_FIXTURE };
    });
    const r = await getClients({ host: "192.168.1.1", api_key: "unitest-key" });
    assert.equal(r.ok, true);
    assert.ok(paths.includes("/proxy/network/api/s/default/stat/sta"));
  });
});

describe("unifi sta parse", () => {
  it("maps rssi essid radio ap_mac to NormalizedClient", async () => {
    const r = await getClients({
      host: "10.0.0.1",
      api_key: "k",
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/stat/sta")) {
          return { status: 200, headers: {}, body: STA_FIXTURE };
        }
        throw new Error("unexpected " + path);
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.clients.length, 2);
    const wifi = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:01");
    const wired = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:02");
    assert.equal(wifi.name, "Work laptop");
    assert.equal(wifi.ip, "192.168.1.20");
    assert.equal(wifi.online, true);
    assert.equal(wifi.rssi, -48);
    assert.equal(wifi.signal_pct, 100);
    assert.equal(wifi.band, "5");
    assert.equal(wifi.ssid, "Home5G");
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
