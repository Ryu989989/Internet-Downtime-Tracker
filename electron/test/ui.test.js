"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

describe("UI hardening", () => {
  it("monitors_json textarea allows up to 8000 characters", () => {
    const html = fs.readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
    assert.match(html, /<textarea[^>]*name="monitors_json"[^>]*maxlength="8000"/);
  });

  it("escapes traceroute hop values in History snapshot rendering", () => {
    const js = fs.readFileSync(path.join(repoRoot, "web", "app.js"), "utf8");
    const blockMatch = js.match(/snap\.traceroute[\s\S]{0,600}/);
    assert.ok(blockMatch);
    const snippet = blockMatch[0];
    assert.ok(snippet.includes("escapeHtml"));
    assert.ok(!/h\.ip[^}]*\+ *"/s.test(snippet) || snippet.includes("escapeHtml(String(h.ip"));
    assert.ok(!/h\.rtt_ms[^}]*\+ *" ms"/s.test(snippet) || snippet.includes("escapeHtml(h.rtt_ms"));
  });

  it("desktop widget fieldset uses named inputs", () => {
    const html = fs.readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
    assert.match(html, /<legend>Desktop widget<\/legend>/);
    for (const name of [
      "widget_enabled",
      "widget_always_on_top",
      "widget_fill_pct",
      "widget_width",
      "widget_height",
      "widget_mod_speed",
    ]) {
      assert.match(html, new RegExp(`name="${name}"`));
    }
  });

  it("Overview adapter chips use honest wifi tip ids", () => {
    const html = fs.readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
    for (const id of [
      "adapterLine",
      "adapterSsidChip",
      "adapterRssiChip",
      "adapterSignalChip",
      "adapterBandChip",
      "adapterClientsChip",
      "adapterBssidChip",
      "adapterRateChip",
      "adapterStateChip",
      "wifiVerdictChip",
    ]) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    for (const tip of [
      "adapter-ssid",
      "adapter-rssi",
      "adapter-signal",
      "adapter-band",
      "adapter-kind",
      "router-clients",
      "adapter-bssid",
      "adapter-rate",
      "adapter-state",
      "wifi-verdict",
    ]) {
      assert.match(html, new RegExp(`data-tip="${tip}"`));
    }
    const js = fs.readFileSync(path.join(repoRoot, "web", "app.js"), "utf8");
    assert.match(js, /"adapter-signal-nodbm"/);
    assert.match(js, /never estimated from %/);
    assert.match(js, /"adapter-ethernet"/);
    assert.match(js, /"router-ssid"/);
    assert.match(js, /"router-rssi"/);
    assert.match(js, /"router-clients"/);
    assert.match(js, /"adapter-bssid"/);
    assert.match(js, /"wifi-verdict"/);
    assert.match(js, /overview_wifi/);
    assert.match(js, /wifi_verdict/);
    assert.match(js, /unproven without router poll/);
    const paint = js.slice(js.indexOf("function paintAdapterLine"), js.indexOf("function paintStatus"));
    assert.ok(paint.includes("finiteOrNull(a.rssi)"));
    assert.ok(paint.includes("overview_wifi"));
    assert.ok(!/rssiToPct/.test(paint));
    assert.match(js, /WIFI_ROUTER_SRC = new Set\(\[[^\]]*unifi/);
    assert.match(js, /WIFI_ROUTER_SRC = new Set\(\[[^\]]*omada/);
  });

  it("Scan tab nearby BSS is a snapshot disclaimer, not a survey", () => {
    const html = fs.readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
    assert.match(html, /id="nearbyWifiRun"/);
    assert.match(html, /not a site survey/);
    const js = fs.readFileSync(path.join(repoRoot, "web", "app.js"), "utf8");
    assert.match(js, /\/api\/lan\/wifi\/nearby/);
    assert.doesNotMatch(js, /rssiToPct/);
  });

  it("widget.html is loadFile-safe (no remote script)", () => {
    const html = fs.readFileSync(path.join(repoRoot, "web", "widget.html"), "utf8");
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
    assert.match(html, /<script[^>]+src="widget\.js"/);
  });
});
