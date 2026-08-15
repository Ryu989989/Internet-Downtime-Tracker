"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  TrackerDb,
  normalizeSettingValue,
  encodeSnapshotJson,
  LIST_OUTAGES_LIMIT_MAX,
} = require("../db");
const { isSafeExternalUrl, isHttpsUrl } = require("../url-policy");
const {
  isAllowedDownloadUrl,
  isTrustedCliPath,
  verifyOfficialZip,
  OFFICIAL_WIN64_SHA256,
} = require("../speedtest");
const { Monitor } = require("../monitor");

describe("url policy (H1)", () => {
  it("allows http(s) only for openExternal", () => {
    assert.equal(isSafeExternalUrl("https://www.speedtest.net/result/1"), true);
    assert.equal(isSafeExternalUrl("http://example.com"), true);
    assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
    assert.equal(isSafeExternalUrl("file:///C:/Windows/System32"), false);
    assert.equal(isSafeExternalUrl("data:text/html,hi"), false);
    assert.equal(isSafeExternalUrl(null), false);
  });

  it("https-only helper for dashboard hrefs (M2)", () => {
    assert.equal(isHttpsUrl("https://www.speedtest.net/result/1"), true);
    assert.equal(isHttpsUrl("http://example.com"), false);
  });
});

describe("settings clamp (H2)", () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-set-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects 0 / NaN / negatives; clamps into bounds", () => {
    assert.equal(normalizeSettingValue("poll_interval_s", 0), null);
    assert.equal(normalizeSettingValue("poll_interval_s", -1), null);
    assert.equal(normalizeSettingValue("poll_interval_s", "nope"), null);
    assert.equal(normalizeSettingValue("poll_interval_s", 1), 2);
    assert.equal(normalizeSettingValue("poll_interval_s", 99999), 3600);
    assert.equal(normalizeSettingValue("debounce_fail_count", 0), null);
    assert.equal(normalizeSettingValue("debounce_fail_count", 1), 1);
    assert.equal(normalizeSettingValue("debounce_fail_count", 99), 20);

    db.updateSettings({ poll_interval_s: 0, debounce_fail_count: -3 });
    const s = db.getSettings();
    assert.equal(s.poll_interval_s, 5);
    assert.equal(s.debounce_fail_count, 2);

    db.updateSettings({ poll_interval_s: 1, debounce_fail_count: 50 });
    const s2 = db.getSettings();
    assert.equal(s2.poll_interval_s, 2);
    assert.equal(s2.debounce_fail_count, 20);
  });

  it("clamps listOutages LIMIT (M3)", () => {
    for (let i = 0; i < 3; i++) db.openOutage("lan", 1_700_000_000 + i);
    const rows = db.listOutages({ limit: 1e9 });
    assert.ok(rows.length <= LIST_OUTAGES_LIMIT_MAX);
    const tiny = db.listOutages({ limit: 1 });
    assert.equal(tiny.length, 1);
  });

  it("coerces bool settings without treating string false as true", () => {
    assert.equal(normalizeSettingValue("toast_alerts", "false"), false);
    assert.equal(normalizeSettingValue("autostart", "true"), true);
    assert.equal(normalizeSettingValue("minimize_to_tray", 0), false);
    assert.equal(normalizeSettingValue("toast_alerts", 1), true);
  });

  it("refuses duplicate open outages per type", () => {
    const a = db.openOutage("wan", 1_700_100_000);
    const b = db.openOutage("wan", 1_700_100_100);
    assert.equal(a, b);
    assert.equal(db.getOpenOutages().filter((o) => o.type === "wan").length, 1);
  });

  it("encodeSnapshotJson stays parseable under size pressure", () => {
    const big = {
      at_open: { note: "x".repeat(9000), nested: { deep: "y".repeat(2000) } },
    };
    const text = encodeSnapshotJson(big, 800);
    assert.ok(text.length <= 800);
    assert.doesNotThrow(() => JSON.parse(text));
  });

  it("persist failures do not break later queries", () => {
    const real = db._persistNow.bind(db);
    let calls = 0;
    db._persistNow = () => {
      calls += 1;
      if (calls === 1) return false;
      return real();
    };
    try {
      db.insertProbe(true, true, 1.2);
      db.flushPersist();
      const rows = db.listSpeedTests({ limit: 5 });
      assert.ok(Array.isArray(rows));
      const open = db.getOpenOutages();
      assert.ok(Array.isArray(open));
    } finally {
      db._persistNow = real;
    }
  });
});

describe("Ookla download trust (H3/M10)", () => {
  it("pins redirect hosts to https Ookla/speedtest domains", () => {
    assert.equal(
      isAllowedDownloadUrl(
        "https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-win64.zip"
      ),
      true
    );
    assert.equal(isAllowedDownloadUrl("https://cdn.speedtest.net/file.zip"), true);
    assert.equal(isAllowedDownloadUrl("http://install.speedtest.net/x"), false);
    assert.equal(isAllowedDownloadUrl("https://evil.example/x.zip"), false);
  });

  it("requires speedtest basename under allowlisted dirs", () => {
    const userData = path.join(os.tmpdir(), "idt-ud");
    const good = path.join(userData, "speedtest", "speedtest.exe");
    assert.equal(isTrustedCliPath(good, userData), true);
    assert.equal(
      isTrustedCliPath(path.join(os.tmpdir(), "evil", "speedtest.exe"), userData),
      false
    );
    assert.equal(
      isTrustedCliPath(path.join(userData, "speedtest", "malware.exe"), userData),
      false
    );
  });

  it("verifyOfficialZip rejects wrong digest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-zip-"));
    const bad = path.join(dir, "bad.zip");
    fs.writeFileSync(bad, "not-the-official-zip");
    assert.throws(() => verifyOfficialZip(bad), /integrity check/);
    const good = path.join(dir, "good.zip");
    const payload = Buffer.from("pinned-bytes");
    fs.writeFileSync(good, payload);
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    // Temporarily not equal to official pin — still rejects.
    assert.notEqual(digest, OFFICIAL_WIN64_SHA256);
    assert.throws(() => verifyOfficialZip(good), /integrity check/);
    assert.equal(verifyOfficialZip(good, digest), digest);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects private probe targets in settings (SSRF)", () => {
    assert.equal(normalizeSettingValue("http_url", "http://127.0.0.1/"), null);
    assert.equal(normalizeSettingValue("http_url", "http://192.168.1.1/"), null);
    assert.equal(normalizeSettingValue("dns_resolver", "127.0.0.1"), null);
    assert.equal(normalizeSettingValue("wan_targets", "192.168.0.1:443"), null);
    assert.equal(normalizeSettingValue("wan_targets", "1.1.1.1:443"), "1.1.1.1:443");
  });
});

describe("WAN streak + timer overlap (M4/M5)", () => {
  let dir;
  let db;
  let monitor;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-wan-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    monitor = new Monitor(db, {
      probeFn: async () => ({
        lan_ok: true,
        wan_ok: true,
        gateway: "192.168.1.1",
        latency_ms: 1,
        lan_method: "icmp",
      }),
    });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resets WAN fail streak while LAN is down", () => {
    monitor.processResult(
      { lan_ok: true, wan_ok: false, gateway: "g", latency_ms: 1, lan_method: "icmp" },
      3
    );
    assert.equal(monitor.state.wan_fail_streak, 1);
    monitor.processResult(
      { lan_ok: false, wan_ok: false, gateway: "g", latency_ms: null, lan_method: "failed" },
      3
    );
    assert.equal(monitor.state.wan_fail_streak, 0);
    // After LAN recovers, streak starts fresh (one fail ≠ open at debounce 3).
    monitor.processResult(
      { lan_ok: true, wan_ok: false, gateway: "g", latency_ms: 1, lan_method: "icmp" },
      3
    );
    assert.equal(monitor.state.wan_fail_streak, 1);
    assert.equal(monitor.state.open_wan_id, null);
  });

  it("does not stack timers when a tick is already running", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let probes = 0;
    const slow = new Monitor(db, {
      probeFn: async () => {
        probes += 1;
        await gate;
        return {
          lan_ok: true,
          wan_ok: true,
          gateway: "g",
          latency_ms: 1,
          lan_method: "icmp",
        };
      },
    });
    db.updateSettings({ poll_interval_s: 2 });
    slow._stopped = false;
    const p1 = slow._tick();
    // Second tick while first is in-flight must no-op (no overlapping schedule).
    await slow._tick();
    assert.equal(probes, 1);
    release();
    await p1;
    slow.stop();
  });
});

describe("Connections/Usage IPC surface (preload allowlist)", () => {
  it("exposes only allowlisted idt methods for connections/usage", () => {
    const preload = fs.readFileSync(
      path.join(__dirname, "..", "preload.js"),
      "utf8"
    );
    assert.match(preload, /connectionsSnapshot:/);
    assert.match(preload, /lanDevicesPing:/);
    assert.match(preload, /lanDevicesTraceroute:/);
    assert.match(preload, /usageStatus:/);
    assert.match(preload, /usageLive:/);
    assert.match(preload, /usageEnable:/);
    assert.match(preload, /usageBlock:/);
    assert.match(preload, /usageUnblock:/);
    assert.doesNotMatch(preload, /ipcRenderer\.invoke\([^)]*\$\{/);
    assert.doesNotMatch(preload, /exposeInMainWorld\("idt",\s*ipcRenderer/);
  });

  it("registers connections/usage channels via safeHandle in main", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert.match(main, /safeHandle\("api:connections:snapshot"/);
    assert.match(main, /safeHandle\("api:lan:devices:ping"/);
    assert.match(main, /safeHandle\("api:lan:devices:traceroute"/);
    assert.match(main, /safeHandle\("api:usage:enable"/);
    assert.match(main, /safeHandle\("api:usage:block"/);
    assert.match(main, /assertControlAllowed/);
    assert.match(main, /sanitizeExePath/);
    const monitor = fs.readFileSync(path.join(__dirname, "..", "monitor.js"), "utf8");
    assert.doesNotMatch(monitor, /tracerouteHost/);
    assert.doesNotMatch(monitor, /pingDevice/);
    assert.doesNotMatch(monitor, /api:lan:devices:ping/);
    assert.doesNotMatch(monitor, /api:lan:devices:traceroute/);
    assert.doesNotMatch(monitor, /\bcheckHttp\b/);
    assert.doesNotMatch(monitor, /https\.request/);
    for (const mod of [
      "lan-devices",
      "lan-bridge",
      "traceroute",
      "usage-bridge",
      "connections",
      "snmp-topology",
      "packet-sniffer",
      "port-scan",
    ]) {
      assert.doesNotMatch(monitor, new RegExp(`require\\(["']\\./${mod}["']\\)`));
    }
    assert.doesNotMatch(monitor, /usage-bridge/);
    assert.doesNotMatch(monitor, /snmp-topology/);
    assert.doesNotMatch(monitor, /packet-sniffer/);
    assert.doesNotMatch(monitor, /port-scan/);
    assert.doesNotMatch(main, /observeSince:\s*monitor(?:\s*\?\s*monitor)?\.state\.started_at/);
    assert.match(main, /db\.summary\(null, \{ observeSince \}\)/);
  });
});
