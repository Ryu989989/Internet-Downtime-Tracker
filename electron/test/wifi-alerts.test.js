"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TrackerDb, parseWifiAlertsJson, normalizeSettingValue } = require("../db");
const lanBridge = require("../lan-bridge");
const { setPostJsonForTest, clearDigestForTest, pendingDigestCount } = require("../notify-webhooks");

const MAC = "AA:BB:CC:DD:EE:FF";

function cfg(over = {}) {
  return {
    enabled: true,
    rssi_dbm: -70,
    signal_pct: 40,
    debounce_n: 2,
    macs: [],
    ...over,
  };
}

describe("wifi_alerts_json", () => {
  it("normalizes shape and clamps", () => {
    const raw = normalizeSettingValue("wifi_alerts_json", {
      enabled: true,
      rssi_dbm: -200,
      signal_pct: 150,
      debounce_n: 99,
      macs: ["aa-bb-cc-dd-ee-ff", "nope", "AA:BB:CC:DD:EE:FF"],
    });
    const parsed = parseWifiAlertsJson(raw);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.rssi_dbm, -120);
    assert.equal(parsed.signal_pct, 100);
    assert.equal(parsed.debounce_n, 20);
    assert.deepEqual(parsed.macs, ["AA:BB:CC:DD:EE:FF"]);
    assert.equal(normalizeSettingValue("wifi_alerts_json", "not-json"), null);
  });
});

describe("RSSI alert evaluate", () => {
  it("debounces N consecutive weaker samples then cooldown", () => {
    const streaks = new Map();
    const lastFired = new Map();
    const sample = { mac: MAC, rssi: -80, signal_pct: 20, source: "asus" };
    const first = lanBridge.evaluateWifiAlerts({
      cfg: cfg(),
      samples: [sample],
      streaks,
      lastFired,
      nowSec: 1000,
      cooldownS: 900,
    });
    assert.equal(first.fires.length, 0);
    assert.equal(first.alerting.size, 0);
    const second = lanBridge.evaluateWifiAlerts({
      cfg: cfg(),
      samples: [sample],
      streaks: first.streaks,
      lastFired,
      nowSec: 1030,
      cooldownS: 900,
    });
    assert.equal(second.fires.length, 1);
    assert.equal(second.fires[0].mac, MAC);
    assert.ok(second.alerting.has(MAC));
    lastFired.set(MAC, 1030);
    const third = lanBridge.evaluateWifiAlerts({
      cfg: cfg(),
      samples: [sample],
      streaks: second.streaks,
      lastFired,
      nowSec: 1060,
      cooldownS: 900,
    });
    assert.equal(third.fires.length, 0);
    assert.ok(third.alerting.has(MAC));
  });

  it("uses dBm when present else signal %", () => {
    const c = cfg({ debounce_n: 1, rssi_dbm: -70, signal_pct: 40 });
    const dbm = lanBridge.evaluateWifiAlerts({
      cfg: c,
      samples: [{ mac: MAC, rssi: -80, signal_pct: 90, source: "asus" }],
      streaks: new Map(),
      lastFired: new Map(),
      nowSec: 1,
    });
    assert.equal(dbm.fires.length, 1);
    const strongDbm = lanBridge.evaluateWifiAlerts({
      cfg: c,
      samples: [{ mac: MAC, rssi: -50, signal_pct: 10, source: "asus" }],
      streaks: new Map(),
      lastFired: new Map(),
      nowSec: 1,
    });
    assert.equal(strongDbm.fires.length, 0);
    const pctOnly = lanBridge.evaluateWifiAlerts({
      cfg: c,
      samples: [{ mac: "11:22:33:44:55:66", rssi: null, signal_pct: 20, source: "nighthawk" }],
      streaks: new Map(),
      lastFired: new Map(),
      nowSec: 1,
    });
    assert.equal(pctOnly.fires.length, 1);
    const pctOk = lanBridge.evaluateWifiAlerts({
      cfg: c,
      samples: [{ mac: "11:22:33:44:55:66", rssi: null, signal_pct: 80, source: "nighthawk" }],
      streaks: new Map(),
      lastFired: new Map(),
      nowSec: 1,
    });
    assert.equal(pctOk.fires.length, 0);
  });
});

describe("RSSI alert quiet hours", () => {
  let dir;
  let db;
  let posted;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-wifi-alert-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    lanBridge.resetRouterPollForTest();
    lanBridge.init({ db, monitor: null });
    posted = [];
    clearDigestForTest();
    setPostJsonForTest((url, body) => {
      posted.push({ url, body });
      return { ok: true, status: 200 };
    });
    lanBridge.setRouterPollForTest({
      createAdapter: () => ({
        testConnection: async () => ({ ok: true }),
        getClients: async () => ({
          ok: true,
          clients: [
            {
              mac: "aa:bb:cc:dd:ee:ff",
              ip: "192.168.1.10",
              online: true,
              rssi: -90,
              signal_pct: 10,
              band: "5",
            },
          ],
        }),
        getRouterHealth: async () => ({ ok: true, cpu_pct: 1, mem_used: 1, mem_total: 2, wan_ok: true }),
      }),
      getActiveAdapter: async () => ({ mac: null }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    db.updateSettings({
      router_poll_enabled: true,
      router_host: "192.168.1.1",
      router_vendor: "asuswrt",
      notify_webhooks_json: JSON.stringify(["https://example.com/hook"]),
      notify_quiet_hours_json: JSON.stringify({ enabled: true, start_hour: 0, end_hour: 0 }),
      toast_alerts: true,
      wifi_alerts_json: {
        enabled: true,
        rssi_dbm: -70,
        signal_pct: null,
        debounce_n: 1,
        macs: [],
      },
    });
  });

  afterEach(() => {
    lanBridge.stopRouterPoll();
    lanBridge.resetRouterPollForTest();
    lanBridge.shutdown();
    clearDigestForTest();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("queues wifi_weak during quiet hours instead of posting", async () => {
    await lanBridge.pollRouterOnce();
    assert.equal(posted.length, 0);
    assert.ok(pendingDigestCount() >= 1);
    const devices = lanBridge.listDevices().devices || [];
    const row = devices.find((d) => d.mac === MAC);
    assert.ok(row);
    assert.equal(row.wifi_alerting, true);
  });
});
