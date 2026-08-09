"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { TrackerDb } = require("../db");
const { Monitor } = require("../monitor");

function makeResult(lan, wan, dns = true, http = true) {
  return {
    lan_ok: lan,
    wan_ok: wan,
    dns_ok: lan && wan ? dns : false,
    http_ok: lan && wan && dns ? http : false,
    gateway: "192.168.1.1",
    latency_ms: 5,
    lan_method: "icmp",
  };
}

describe("monitor debounce", async () => {
  let dir;
  let db;
  let monitor;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    monitor = new Monitor(db, { probeFn: async () => makeResult(true, true) });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens LAN outage after 2 consecutive fails", () => {
    monitor.processResult(makeResult(false, false), 2);
    assert.equal(monitor.state.open_lan_id, null);
    monitor.processResult(makeResult(false, false), 2);
    assert.ok(monitor.state.open_lan_id != null);
    const open = db.getOpenOutages();
    assert.equal(open.length, 1);
    assert.equal(open[0].type, "lan");
  });

  it("closes LAN outage on one success", () => {
    const id = monitor.state.open_lan_id;
    assert.ok(id != null);
    monitor.processResult(makeResult(true, true), 2);
    assert.equal(monitor.state.open_lan_id, null);
    const row = db._get("SELECT * FROM outages WHERE id=?", [id]);
    assert.ok(row.ended_at != null);
    assert.ok(row.duration_ms >= 0);
  });

  it("opens WAN only when LAN is up", () => {
    monitor.processResult(makeResult(true, false), 2);
    assert.equal(monitor.state.open_wan_id, null);
    monitor.processResult(makeResult(true, false), 2);
    assert.ok(monitor.state.open_wan_id != null);
    const wanRow = db._get("SELECT * FROM outages WHERE id=?", [monitor.state.open_wan_id]);
    assert.match(String(wanRow.notes || ""), /WAN failed while LAN stayed up/i);

    const before = monitor.state.open_wan_id;
    monitor.processResult(makeResult(false, false), 2);
    monitor.processResult(makeResult(false, false), 2);
    assert.equal(monitor.state.open_wan_id, before);
  });

  it("closes WAN outage on one success", () => {
    const wanId = monitor.state.open_wan_id;
    assert.ok(wanId != null);
    monitor.processResult(makeResult(true, true), 2);
    assert.equal(monitor.state.open_wan_id, null);
    const row = db._get("SELECT * FROM outages WHERE id=?", [wanId]);
    assert.ok(row.ended_at != null);
    assert.ok(row.duration_ms >= 0);
  });

  it("opens DNS/HTTP only when lower layers are up", () => {
    // Clear any open WAN from prior test.
    monitor.processResult(makeResult(true, true, true, true), 1);
    assert.equal(monitor.state.open_wan_id, null);

    monitor.processResult(makeResult(true, true, false, false), 2);
    assert.equal(monitor.state.open_dns_id, null);
    monitor.processResult(makeResult(true, true, false, false), 2);
    assert.ok(monitor.state.open_dns_id != null);
    assert.equal(monitor.state.open_http_id, null);

    monitor.processResult(makeResult(true, true, true, false), 2);
    assert.equal(monitor.state.open_dns_id, null);
    assert.equal(monitor.state.open_http_id, null);
    monitor.processResult(makeResult(true, true, true, false), 2);
    assert.ok(monitor.state.open_http_id != null);
  });
});

describe("summary uptime streak", async () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-sum-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caps streak to observeSince when last outage ended earlier", () => {
    const now = 1_700_000_000;
    const observeSince = now - 600; // session started 10 min ago
    const outageEnd = now - 86400; // closed 1 day ago
    db.openOutage("wan", outageEnd - 120);
    const open = db.getOpenOutage("wan");
    db.closeOutage(open.id, outageEnd);

    const sum = db.summary(now, { observeSince });
    assert.equal(sum.in_outage, false);
    assert.ok(sum.uptime_streak_s <= 600.1);
    assert.ok(sum.uptime_streak_s >= 599.9);
  });

  it("uses time since outage end when it is within this session", () => {
    const now = 1_700_100_000;
    const observeSince = now - 3600;
    const outageEnd = now - 120;
    db.openOutage("lan", outageEnd - 30);
    const open = db.getOpenOutage("lan");
    db.closeOutage(open.id, outageEnd);

    const sum = db.summary(now, { observeSince });
    assert.equal(sum.in_outage, false);
    assert.ok(sum.uptime_streak_s <= 120.1);
    assert.ok(sum.uptime_streak_s >= 119.9);
  });

  it("adopts prior-session open outages so recovery can close them", async () => {
    const staleId = db.openOutage("lan", 1_699_000_000);
    let adopted = null;
    const m = new Monitor(db, {
      probeFn: async () => {
        throw new Error("offline");
      },
    });
    await m._bootstrap();
    adopted = m.state.open_lan_id;
    assert.equal(adopted, staleId);

    // First success after resume is grace (no close); second confirms.
    m.processResult(makeResult(true, true), 1);
    assert.equal(m.state.open_lan_id, staleId);
    m.processResult(makeResult(true, true), 1);
    assert.equal(m.state.open_lan_id, null);
    const row = db._get("SELECT * FROM outages WHERE id=?", [staleId]);
    assert.ok(row.ended_at != null);
  });

  it("closes DNS/HTTP on success and resets streaks when prerequisite down", () => {
    const m = new Monitor(db, { probeFn: async () => makeResult(true, true) });
    m.processResult(makeResult(true, true, false, false), 2);
    m.processResult(makeResult(true, true, false, false), 2);
    const dnsId = m.state.open_dns_id;
    assert.ok(dnsId != null);

    m.processResult(makeResult(true, true, true, true), 2);
    assert.equal(m.state.open_dns_id, null);
    assert.ok(db._get("SELECT ended_at FROM outages WHERE id=?", [dnsId]).ended_at);

    m.processResult(makeResult(true, true, true, false), 2);
    m.processResult(makeResult(true, true, true, false), 2);
    const httpId = m.state.open_http_id;
    assert.ok(httpId != null);
    m.processResult(makeResult(true, true, true, true), 2);
    assert.equal(m.state.open_http_id, null);

    // Streak reset: DNS streak clears when WAN down; HTTP when DNS down.
    m.processResult(makeResult(true, true, false, false), 2);
    assert.equal(m.state.dns_fail_streak, 1);
    m.processResult(makeResult(true, false, false, false), 2);
    assert.equal(m.state.dns_fail_streak, 0);

    m.processResult(makeResult(true, true, true, false), 2);
    assert.equal(m.state.http_fail_streak, 1);
    m.processResult(makeResult(true, true, false, false), 2);
    assert.equal(m.state.http_fail_streak, 0);
  });
});

describe("monitor probe suppress / cool-down", async () => {
  let dir;
  let db;
  let monitor;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-sup-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    monitor = new Monitor(db, { probeFn: async () => makeResult(true, true) });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not open outages from failures during cool-down", () => {
    monitor.setProbeSuppress(true);
    assert.equal(monitor.state.probe_suppressed, true);
    monitor.setProbeSuppress(false, { cooldownMs: 60_000 });
    assert.equal(monitor.state.probe_suppressed, false);
    // Simulate ticks during cool-down (successesOnly path).
    monitor._applyProbe(makeResult(true, false), 2, true, { successesOnly: true });
    monitor._applyProbe(makeResult(true, false), 2, true, { successesOnly: true });
    assert.equal(monitor.state.open_wan_id, null);
    assert.equal(db.getOpenOutages().length, 0);
  });

  it("refcounts overlapping probe suppress holders", () => {
    monitor.setProbeSuppress(true);
    monitor.setProbeSuppress(true);
    assert.equal(monitor.state.probe_suppressed, true);
    monitor.setProbeSuppress(false, { cooldownMs: 0 });
    assert.equal(monitor.state.probe_suppressed, true);
    assert.equal(monitor._suppressDepth, 1);
    monitor.setProbeSuppress(false, { cooldownMs: 0 });
    assert.equal(monitor.state.probe_suppressed, false);
    assert.equal(monitor._suppressDepth, 0);
  });

  it("includes provider on summary from latest speed test", () => {
    assert.equal(db.summary().provider, null);
    db.insertSpeedTest({
      tested_at: Date.now() / 1000,
      download_mbps: 100,
      upload_mbps: 20,
      ping_ms: 12.5,
      jitter_ms: 1,
      packet_loss: 0,
      server_name: "City Fiber",
      server_id: "1",
      server_location: "Austin, TX",
      isp: "Example ISP",
      result_url: null,
      raw_json: null,
    });
    const sum = db.summary();
    assert.equal(sum.provider.isp, "Example ISP");
    assert.equal(sum.provider.server_name, "City Fiber");
    assert.equal(sum.provider.server_location, "Austin, TX");
    assert.equal(sum.provider.ping_ms, 12.5);
  });

  it("stores incident snapshot on open and close", () => {
    monitor.processResult(makeResult(true, true), 1);
    monitor.state.adapter = { name: "Eth0", type: "ethernet", signal: null };
    monitor.processResult(makeResult(true, false), 1);
    const id = monitor.state.open_wan_id;
    assert.ok(id != null);
    const openRow = db._get("SELECT * FROM outages WHERE id=?", [id]);
    const openSnap = JSON.parse(openRow.snapshot_json);
    assert.ok(openSnap.at_open);
    assert.equal(openSnap.at_open.type, "wan");
    assert.equal(openSnap.at_open.wan_ok, false);
    assert.equal(openSnap.at_open.adapter.name, "Eth0");

    monitor.processResult(makeResult(true, true), 1);
    const closed = db._get("SELECT * FROM outages WHERE id=?", [id]);
    const snap = JSON.parse(closed.snapshot_json);
    assert.ok(snap.at_open);
    assert.ok(snap.at_close);
    assert.equal(snap.at_close.wan_ok, true);
  });

  it("snapshot reports monitor_stale when probes age out", () => {
    monitor.state.paused = false;
    monitor.state.probe_suppressed = false;
    monitor.state.last_probe_at = Date.now() / 1000 - 20;
    db.updateSettings({ poll_interval_s: 5 });
    const snap = monitor.snapshot();
    assert.equal(snap.monitor_stale, true);
    monitor.state.paused = true;
    assert.equal(monitor.snapshot().monitor_stale, false);
  });
});

describe("monitor pause mid-probe", async () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-pause-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores in-flight probe after pause", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const m = new Monitor(db, {
      probeFn: async () => {
        await gate;
        return makeResult(true, false);
      },
    });
    db.updateSettings({ debounce_fail_count: 1 });
    m._stopped = false;
    const tick = m._tick();
    await new Promise((r) => setImmediate(r));
    m.pause();
    release();
    await tick;
    m.stop();
    assert.equal(m.state.open_wan_id, null);
    assert.equal(db.getOpenOutages().length, 0);
  });

  it("_tick reads debounce_fail_count from settings", async () => {
    db.updateSettings({ debounce_fail_count: 3 });
    let n = 0;
    const m = new Monitor(db, {
      probeFn: async () => {
        n += 1;
        return makeResult(true, false);
      },
    });
    m._stopped = false;
    await m._tick();
    await m._tick();
    assert.equal(m.state.open_wan_id, null);
    await m._tick();
    assert.ok(m.state.open_wan_id != null);
    assert.equal(n, 3);
    m.stop();
  });
});
