"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  testConnection,
  getClients,
  getRouterHealth,
  setRequestFn,
  resetRequestFn,
  USER_AGENT,
} = require("../asuswrt");

afterEach(() => {
  resetRequestFn();
});

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function headerOf(init, name) {
  const h = (init && init.headers) || {};
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (String(k).toLowerCase() === want) return String(v);
  }
  return "";
}

describe("asuswrt private-IP reject", () => {
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

describe("asuswrt login", () => {
  it("tries legacy login.cgi then nonce login_v2", async () => {
    const nonce = "n0nceValue";
    const paths = [];
    let v2Body = "";
    setRequestFn(async (url, init) => {
      const path = new URL(url).pathname;
      const body = String((init && init.body) || "");
      paths.push(path);
      assert.match(headerOf(init, "user-agent"), /asusrouter-Android-DUTUtil/);
      assert.equal(USER_AGENT, headerOf(init, "user-agent"));
      if (path.endsWith("/login.cgi")) {
        assert.equal((init && init.method) || "GET", "POST");
        const auth = new URLSearchParams(body).get("login_authorization");
        assert.equal(Buffer.from(auth, "base64").toString("utf8"), "admin:secret");
        return { status: 200, headers: {}, body: "error_status=2" };
      }
      if (path.endsWith("/get_Nonce.cgi")) {
        return { status: 200, headers: {}, body: JSON.stringify({ nonce }) };
      }
      if (path.endsWith("/login_v2.cgi")) {
        v2Body = body;
        return {
          status: 200,
          headers: { "set-cookie": "asus_token=tok123; Path=/" },
          body: "success",
        };
      }
      if (path.endsWith("/appGet.cgi")) {
        assert.match(headerOf(init, "cookie"), /asus_token=tok123/);
        assert.match(decodeURIComponent(body), /nvram_get\(productid\)/);
        return { status: 200, headers: {}, body: "productid=RT-AX88U;firmver=3.0.0.4;" };
      }
      throw new Error("unexpected " + path);
    });

    const r = await testConnection({
      host: "192.168.1.1",
      user: "admin",
      password: "secret",
      https: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.model, "RT-AX88U");
    assert.equal(r.firmware, "3.0.0.4");
    assert.deepEqual(paths.slice(0, 3), ["/login.cgi", "/get_Nonce.cgi", "/login_v2.cgi"]);
    const params = new URLSearchParams(v2Body);
    const cnonce = params.get("login_cnonce");
    assert.ok(cnonce);
    assert.equal(params.get("login_authorization"), sha256(`admin:${nonce}:secret:${cnonce}`));
  });
});

describe("asuswrt get_clientlist", () => {
  it("parses clients and merges sta-list RF", async () => {
    const fixture = [
      "get_clientlist={",
      '"macList":["AA:BB:CC:DD:EE:01","AA:BB:CC:DD:EE:02"],',
      '"AA:BB:CC:DD:EE:01":{"mac":"AA:BB:CC:DD:EE:01","ip":"192.168.1.20","name":"laptop",',
      '"nickName":"Work laptop","isOnline":"1","isWL":"2","rssi":"-48","curTx":"1201","curRx":"866",',
      '"ssid":"Home5G","from":"11:22:33:44:55:66"},',
      '"AA:BB:CC:DD:EE:02":{"mac":"AA:BB:CC:DD:EE:02","ip":"192.168.1.21","name":"printer",',
      '"isOnline":"1","isWL":"0","rssi":"0"}',
      "};",
      'wl_sta_list_5g={"AA:BB:CC:DD:EE:01":{"rssi":"-47","tx":"1201","rx":"866"}};',
    ].join("");

    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/login.cgi")) {
        return {
          status: 200,
          headers: { "set-cookie": "asus_token=sess; Path=/" },
          body: "ok",
        };
      }
      if (path.endsWith("/appGet.cgi")) {
        assert.match(String((init && init.body) || ""), /get_clientlist\(\)/);
        assert.match(String((init && init.body) || ""), /wl_sta_list_5g/);
        return { status: 200, headers: {}, body: fixture };
      }
      throw new Error("unexpected " + path);
    };

    const r = await getClients({
      host: "192.168.1.2",
      user: "admin",
      password: "secret",
      fetch,
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
  });
});

describe("asuswrt getRouterHealth", () => {
  it("parses cpu mem wan model from appGet", async () => {
    const body = [
      'cpu_usage={"cpu_total":{"total":"100","usage":"18"}};',
      'memory_usage={"mem_total":"262144","mem_used":"81920","mem_free":"180224"};',
      "wanlink_state=2;",
      "wanlink_status=1;",
      'wanlink_ipaddr="203.0.113.10";',
      "productid=RT-AX88U;",
      "firmver=3.0.0.4;",
    ].join("");

    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/login.cgi")) {
        return {
          status: 200,
          headers: { "set-cookie": "asus_token=health; Path=/" },
          body: "ok",
        };
      }
      if (path.endsWith("/appGet.cgi")) {
        const hook = String((init && init.body) || "");
        assert.match(hook, /cpu_usage\(appobj\)/);
        assert.match(hook, /memory_usage\(appobj\)/);
        assert.match(hook, /wanlink_state/);
        assert.doesNotMatch(hook, /applyapp/i);
        return { status: 200, headers: {}, body };
      }
      throw new Error("unexpected " + path);
    };

    const r = await getRouterHealth({
      host: "10.0.0.1",
      user: "admin",
      password: "secret",
      https: true,
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.cpu_pct, 18);
    assert.equal(r.mem_used, 81920);
    assert.equal(r.mem_total, 262144);
    assert.equal(r.wan_ok, true);
    assert.equal(r.wan_ip, "203.0.113.10");
    assert.equal(r.model, "RT-AX88U");
    assert.equal(r.firmware, "3.0.0.4");
  });
});
