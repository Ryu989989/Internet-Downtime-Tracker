"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TrackerDb } = require("../db");
const { createAdapter, wifiSampleSource } = require("../router-adapter");
const lanBridge = require("../lan-bridge");

const CLIENT = {
  mac: "aa:bb:cc:dd:ee:ff",
  ip: "192.168.1.10",
  name: "Living TV",
  online: true,
  rssi: -62,
  signal_pct: 70,
  band: "5",
  ssid: "Home",
  tx_mbps: 866,
  rx_mbps: 400,
  node_mac: "11:22:33:44:55:66",
};

function fakeAdapter({ clients = [CLIENT], health, test } = {}) {
  return {
    testConnection: async (opts) =>
      test ? test(opts) : { ok: true, model: "RT-AX86U", firmware: "3.0" },
    getClients: async () => ({ ok: true, clients }),
    getRouterHealth: async () =>
      health || {
        ok: true,
        cpu_pct: 12,
        mem_used: 100,
        mem_total: 512,
        wan_ok: true,
        wan_ip: "1.2.3.4",
        model: "RT-AX86U",
        firmware: "3.0",
      },
  };
}

describe("router poller / IPC", () => {
  let dir;
  let db;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-router-poll-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    lanBridge.resetRouterPollForTest();
    lanBridge.init({ db, monitor: null });
    lanBridge.setRouterPollForTest({
      createAdapter: () => fakeAdapter(),
      getActiveAdapter: async () => ({ mac: null }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    db.updateSettings({
      router_poll_enabled: true,
      router_vendor: "asuswrt",
      router_host: "192.168.1.1",
      router_user: "admin",
      router_password: "wifi-secret",
      router_interval_s: 30,
    });
  });

  afterEach(async () => {
    lanBridge.stopRouterPoll();
    for (let i = 0; i < 50 && lanBridge.getRouterPollStatus().in_flight; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    lanBridge.resetRouterPollForTest();
    lanBridge.shutdown();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("createAdapter maps one vendor and sample source", () => {
    assert.equal(wifiSampleSource("asuswrt"), "asus");
    assert.equal(wifiSampleSource("nighthawk"), "nighthawk");
    assert.equal(wifiSampleSource("unifi"), "unifi");
    assert.equal(wifiSampleSource("omada"), "omada");
    assert.equal(wifiSampleSource("nope"), null);
    const a = createAdapter("asuswrt");
    const n = createAdapter("nighthawk");
    assert.equal(typeof a.testConnection, "function");
    assert.equal(typeof a.getClients, "function");
    assert.equal(typeof a.getRouterHealth, "function");
    assert.equal(typeof n.testConnection, "function");
    const u = createAdapter("unifi");
    const o = createAdapter("omada");
    if (u) assert.equal(typeof u.getClients, "function");
    if (o) assert.equal(typeof o.getClients, "function");
  });

  it("merges clients by MAC without dupes and tags sample source", async () => {
    db.upsertLanDevice({
      mac: "AA:BB:CC:DD:EE:FF",
      ip: "192.168.1.10",
      alias: "TV",
      notes: "den",
      online: true,
      source: "neighbor",
    });
    await lanBridge.pollRouterOnce();
    await lanBridge.pollRouterOnce();
    const rows = db.listLanDevices().filter((d) => d.mac === "AA:BB:CC:DD:EE:FF");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alias, "TV");
    assert.equal(rows[0].notes, "den");
    assert.equal(rows[0].wifi_rssi, -62);
    assert.equal(rows[0].wifi_ssid, "Home");
    const asus = db.listWifiHistory({ mac: "AA:BB:CC:DD:EE:FF" });
    assert.equal(asus.length, 2);
    assert.ok(asus.every((s) => s.source === "asus"));

    db.updateSettings({ router_vendor: "nighthawk" });
    lanBridge.setRouterPollForTest({
      createAdapter: () => fakeAdapter(),
      getActiveAdapter: async () => ({ mac: null }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    await lanBridge.pollRouterOnce();
    assert.equal(db.listLanDevices().filter((d) => d.mac === "AA:BB:CC:DD:EE:FF").length, 1);
    const hist = db.listWifiHistory({ mac: "AA:BB:CC:DD:EE:FF" });
    assert.ok(hist.some((s) => s.source === "nighthawk"));
    assert.ok(hist.some((s) => s.source === "asus"));

    const payload = lanBridge.listDevices();
    assert.equal(payload.router_health.vendor, "nighthawk");
    assert.equal(payload.router_health.error, null);
    assert.equal(payload.router_health.cpu_pct, 12);
    assert.equal(payload.host_adapter.mac, null);
    const ow = lanBridge.overviewWifiPayload({ type: "ethernet", name: "Ethernet" });
    assert.equal(ow.ssid, "Home");
    assert.equal(ow.source, "nighthawk");
    assert.equal(ow.this_pc_on_wifi, false);
    assert.equal(ow.client_count, 1);
    assert.equal(ow.weakest_rssi, -62);
    const health = lanBridge.getRouterHealth();
    assert.equal(health.vendor, "nighthawk");
    assert.equal(health.cpu_pct, 12);
  });

  it("inserts host_nic wifi sample keyed by adapter MAC", async () => {
    lanBridge.setRouterPollForTest({
      createAdapter: () => fakeAdapter({ clients: [] }),
      getActiveAdapter: async () => ({
        mac: "aa-bb-cc-11-22-33",
        ssid: "Home",
        bssid: "11:22:33:44:55:66",
        band: "5",
        channel: 36,
        rssi: -50,
        signal: 80,
        tx_mbps: 1200,
        rx_mbps: 800,
        type: "wifi",
      }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    await lanBridge.pollRouterOnce();
    const mac = "AA:BB:CC:11:22:33";
    const hist = lanBridge.listWifiHistory({ mac });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].source, "host_nic");
    assert.equal(hist[0].rssi, -50);
    assert.equal(hist[0].signal_pct, 80);
    assert.equal(hist[0].ssid, "Home");
    const payload = lanBridge.listDevices();
    assert.equal(payload.host_adapter.mac, "aa-bb-cc-11-22-33");
    assert.equal(payload.host_adapter.signal, 80);
  });

  it("testConnection uses saved password and fail-closes on public host", async () => {
    let seen = null;
    lanBridge.setRouterPollForTest({
      createAdapter: () =>
        fakeAdapter({
          test: async (opts) => {
            seen = opts;
            return { ok: true, model: "RT-AX86U" };
          },
        }),
      getActiveAdapter: async () => ({ mac: null }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    const ok = await lanBridge.testRouterConnection();
    assert.equal(ok.ok, true);
    assert.equal(seen.host, "192.168.1.1");
    assert.equal(seen.user, "admin");
    assert.equal(seen.password, "wifi-secret");

    lanBridge.resetRouterPollForTest();
    db.updateSettings({ router_host: "8.8.8.8", router_vendor: "asuswrt" });
    const bad = await lanBridge.testRouterConnection();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /private or local/i);
  });

  it("start/stop hooks; timer off when poll disabled", () => {
    const on = lanBridge.startRouterPoll();
    assert.equal(on.running, true);
    assert.equal(lanBridge.getRouterPollStatus().running, true);
    lanBridge.stopRouterPoll();
    assert.equal(lanBridge.getRouterPollStatus().running, false);
    db.updateSettings({ router_poll_enabled: false });
    const off = lanBridge.startRouterPoll();
    assert.equal(off.running, false);
    assert.equal(lanBridge.getRouterPollStatus().running, false);
    assert.equal(lanBridge.overviewWifiPayload({ type: "ethernet", name: "Ethernet" }), null);
  });

  it("preload and main expose router IPC", () => {
    const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
    assert.match(preload, /lanRouterTest:/);
    assert.match(preload, /lanWifiHistory:/);
    assert.match(preload, /lanRouterHealth:/);
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert.match(main, /safeHandle\("api:lan:router:test"/);
    assert.match(main, /safeHandle\("api:lan:wifi:history"/);
    assert.match(main, /safeHandle\("api:lan:router:health"/);
    assert.match(main, /overview_wifi/);
    assert.match(main, /overviewWifiPayload/);
    assert.doesNotMatch(main, /not implemented/);
  });

  it("polls each enabled target, merges MAC, keeps both sample sources", async () => {
    db.updateSettings({
      router_poll_enabled: true,
      router_targets_json: JSON.stringify([
        { id: "asus", vendor: "asuswrt", host: "192.168.1.1", user: "admin", port: "", https: false, enabled: true },
        { id: "ng", vendor: "nighthawk", host: "192.168.1.2", user: "admin", port: "5000", https: false, enabled: true },
      ]),
      router_secrets_json: JSON.stringify({
        asus: { password: "p-asus", api_key: "" },
        ng: { password: "p-ng", api_key: "" },
      }),
    });
    const seenPw = {};
    lanBridge.setRouterPollForTest({
      createAdapter: (vendor) =>
        fakeAdapter({
          test: async (opts) => {
            seenPw[vendor] = opts.password;
            return { ok: true, model: vendor };
          },
          clients: [
            {
              ...CLIENT,
              rssi: vendor === "nighthawk" ? -40 : -62,
              signal_pct: vendor === "nighthawk" ? 90 : 70,
            },
          ],
          health: {
            ok: true,
            cpu_pct: vendor === "nighthawk" ? 30 : 12,
            mem_used: 100,
            mem_total: 512,
            wan_ok: true,
            wan_ip: "1.2.3.4",
            model: vendor === "nighthawk" ? "RAX50" : "RT-AX86U",
            firmware: "3.0",
          },
        }),
      getActiveAdapter: async () => ({ mac: null }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    await lanBridge.pollRouterOnce();
    const rows = db.listLanDevices().filter((d) => d.mac === "AA:BB:CC:DD:EE:FF");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wifi_rssi, -40);
    const hist = db.listWifiHistory({ mac: "AA:BB:CC:DD:EE:FF" });
    assert.ok(hist.some((s) => s.source === "asus"));
    assert.ok(hist.some((s) => s.source === "nighthawk"));
    const health = lanBridge.getRouterHealth();
    assert.equal(health.targets.length, 2);
    assert.equal(health.targets[0].vendor, "asuswrt");
    assert.equal(health.targets[1].vendor, "nighthawk");
    assert.equal(health.targets[1].cpu_pct, 30);
    assert.equal(health.error, null);
    const asusTest = await lanBridge.testRouterConnection("asus");
    const ngTest = await lanBridge.testRouterConnection("ng");
    assert.equal(asusTest.ok, true);
    assert.equal(ngTest.ok, true);
    assert.equal(seenPw.asuswrt, "p-asus");
    assert.equal(seenPw.nighthawk, "p-ng");
  });
});
