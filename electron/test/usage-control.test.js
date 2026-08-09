"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  evaluateAlerts,
  evaluateCaps,
  sanitizeExePath,
  assertControlAllowed,
} = require("../usage-control");

describe("evaluateAlerts", () => {
  it("fires once per cooldown", () => {
    const fired = new Map();
    const rules = JSON.stringify({
      rules: [{ id: "total", daily_bytes: 1000, enabled: true }],
    });
    const a = evaluateAlerts({
      alertsJson: rules,
      totalsByApp: {},
      globalTotal: 5000,
      nowSec: 1000,
      getLastFired: (k) => fired.get(k),
      cooldownS: 3600,
    });
    assert.equal(a.length, 1);
    fired.set("total", 1000);
    const b = evaluateAlerts({
      alertsJson: rules,
      totalsByApp: {},
      globalTotal: 5000,
      nowSec: 1200,
      getLastFired: (k) => fired.get(k),
      cooldownS: 3600,
    });
    assert.equal(b.length, 0);
  });
});

describe("evaluateCaps", () => {
  it("detects global and per-app hits", () => {
    const hits = evaluateCaps({
      capsJson: {
        global_daily_bytes: 100,
        apps: { chrome: { daily_bytes: 50, auto_block: true, exe_path: "C:\\\\chrome.exe" } },
      },
      dailyByApp: { chrome: 60 },
      monthlyByApp: {},
      dailyGlobal: 150,
      monthlyGlobal: 0,
    });
    assert.ok(hits.some((h) => h.scope === "global"));
    assert.ok(hits.some((h) => h.app_key === "chrome" && h.auto_block));
  });
});

describe("sanitizeExePath / control gate", () => {
  it("accepts Windows paths only", () => {
    assert.ok(sanitizeExePath("C:\\Program Files\\app.exe"));
    assert.equal(sanitizeExePath("../../etc/passwd"), null);
    assert.equal(sanitizeExePath('C:\\x"y.exe'), null);
    assert.equal(sanitizeExePath("\\\\server\\share\\a.exe"), null);
    assert.equal(sanitizeExePath("C:\\Windows\\notepad.com"), null);
  });
  it("throws when master toggle off", () => {
    assert.throws(() => assertControlAllowed({ network_control_enabled: false }), /disabled/i);
  });
});

describe("helper pipe auth contracts", () => {
  it("uses current-user SID ACL and --token-file (not BuiltinUsers / bare --token launch)", () => {
    const root = path.join(__dirname, "..", "..");
    const cs = fs.readFileSync(path.join(root, "helper", "IdtUsageHelper", "Program.cs"), "utf8");
    const bridge = fs.readFileSync(path.join(root, "electron", "usage-bridge.js"), "utf8");
    assert.match(cs, /identity\.User/);
    assert.doesNotMatch(cs, /BuiltinUsersSid/);
    assert.match(cs, /--token-file/);
    assert.match(bridge, /--token-file/);
    assert.doesNotMatch(bridge, /--token \$\{token\}/);
    assert.match(bridge, /hardenTokenFileAcl/);
  });

  it("prefers resourcesPath helper and never returns asar paths; spawns direct when elevated", () => {
    const root = path.join(__dirname, "..", "..");
    const bridge = fs.readFileSync(path.join(root, "electron", "usage-bridge.js"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.match(bridge, /isInsideAsar/);
    assert.match(bridge, /isProcessElevated/);
    assert.match(bridge, /spawnHelperDirect/);
    assert.match(bridge, /resourcesPath/);
    const files = pkg.build.files.join("\n");
    assert.doesNotMatch(files, /helper\/IdtUsageHelper\/publish/);
    const filters = (pkg.build.extraResources || [])
      .map((r) => (Array.isArray(r.filter) ? r.filter.join(",") : String(r.filter || "")))
      .join("|");
    assert.match(filters, /\*\*\/\*/);
  });
});
