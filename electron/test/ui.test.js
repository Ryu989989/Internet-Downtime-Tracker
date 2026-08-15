"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");

describe("dashboard redesign contracts", () => {
  it("uses semantic visual tokens and a native Windows type stack", () => {
    assert.match(css, /--surface-1:/);
    assert.match(css, /--focus-ring:/);
    assert.match(css, /"Segoe UI Variable"/);
  });

  it("keeps polling regions quiet and exposes one status announcement", () => {
    assert.match(html, /id="liveStatus"(?![^>]*aria-live)/);
    assert.match(html, /id="statusAnnouncement"[^>]*aria-live="polite"/);
    assert.match(html, /id="staleBanner"(?![^>]*(?:aria-live|role="status"))/);
    assert.match(html, /id="qualityStrip"(?![^>]*aria-live)/);
    assert.match(html, /id="providerStrip"(?![^>]*aria-live)/);
  });

  it("gives tabs a visible focus ring and compact overflow behavior", () => {
    assert.match(css, /\.tab:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
    assert.match(css, /@media \(max-width:\s*899px\)[\s\S]*?\.tabs\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it("uses accessible timeline and table semantics", () => {
    assert.match(html, /id="timeline24" role="group"/);
    assert.doesNotMatch(html, /id="timeline24" role="img"/);
    assert.match(html, /<caption class="sr-only">Recent outages<\/caption>/);
    assert.match(html, /<th scope="col"[^>]*data-tip="hist-type"[^>]*>Type<\/th>/);
  });

  it("connects expandable incidents and announces note saves", () => {
    assert.match(app, /aria-controls="snapshot-\$\{Number\(o\.id\)\}"/);
    assert.match(app, /id="snapshot-\$\{Number\(o\.id\)\}"/);
    assert.match(app, /notesLive\.textContent = "Note saved"/);
  });

  it("does not ship CSP directives that browsers ignore in meta tags", () => {
    assert.doesNotMatch(html, /frame-ancestors/);
  });

  it("removes closed tooltips from the accessibility tree", () => {
    assert.match(app, /el\.hidden = true;/);
    assert.match(app, /tip\.hidden = false;/);
    assert.match(app, /tip\.hidden = true;/);
    assert.match(app, /el\.id = "chartJsTooltip";[\s\S]*?el\.hidden = true;/);
    assert.match(app, /function showChartTipHtml[\s\S]*?el\.hidden = false;/);
    assert.match(app, /function hideChartTip[\s\S]*?el\.hidden = true;/);
  });

  it("preserves the last good summary when a background refresh fails", () => {
    assert.match(app, /let lastGoodSummary = null;/);
    assert.match(app, /lastGoodSummary = sum;/);
    assert.match(app, /if \(lastGoodSummary\)[\s\S]*?Summary refresh delayed/);
  });

  it("ships Network tab with Devices/Connections/Usage segments and no monitor tick coupling", () => {
    assert.match(html, /data-tab="connections"/);
    assert.match(html, /id="panel-connections"/);
    assert.match(html, />Network</);
    assert.match(html, /id="connViewDevices"/);
    assert.match(html, /id="connViewUsage"/);
    assert.match(html, /id="connViewTopology"/);
    assert.match(app, /refreshConnectionsPanel/);
    assert.match(app, /refreshDevicesPanel/);
    assert.match(app, /\/api\/connections\/snapshot/);
    assert.match(app, /\/api\/lan\/devices/);
    assert.doesNotMatch(app, /status:update[\s\S]{0,200}connectionsSnapshot/);
  });

  it("renders topology as accessible radial rings with node and row tooltips", () => {
    assert.match(app, /function topologyLayout\(/);
    assert.match(app, /function topologyNodeTip\(/);
    assert.match(app, /function topologyDetailHtml\(/);
    assert.match(app, /class="topo-node-group has-tip"/);
    assert.match(app, /class="topo-row has-tip"/);
    assert.match(app, /topo-expand/);
    assert.match(app, /bindTooltips\(graph\)/);
    assert.match(app, /bindTooltips\(tbody\)/);
    assert.match(html, /<th scope="col"[^>]*data-tip="topo-nb"[^>]*>Neighbor<\/th>/);
    assert.match(html, /<th scope="col"[^>]*data-tip="topo-conns"[^>]*>Conns<\/th>/);
    assert.match(app, /function topologyNodeKey\(/);
    assert.match(app, /String\(node\.ip \|\| node\.label \|\| index\)/);
    assert.match(app, /function bindTopoPanZoom\(/);
    assert.match(app, /function selectTopoNode\(/);
    assert.match(app, /prefersReducedMotion\(\)/);
    assert.match(app, /topo-viewport/);
    assert.match(css, /\.topo-edge/);
    assert.match(css, /\.topo-detail/);
    assert.match(css, /\.topo-node-group:focus-visible/);
  });

  it("exposes Usage caps/alerts Settings form wired to usage_*_json keys", () => {
    assert.match(html, /Usage caps &amp; alerts/);
    assert.match(html, /id="usageCapGlobalDailyMib"/);
    assert.match(html, /id="usageAlertGlobalDailyMib"/);
    assert.match(app, /buildUsageCapsAlertsFromForm/);
    assert.match(app, /usage_caps_json:\s*usageJson\.usage_caps_json/);
    assert.match(app, /usage_alerts_json:\s*usageJson\.usage_alerts_json/);
  });

  it("shows Devices-disabled warning and locks Overview/Devices/Connections/Usage tips", () => {
    assert.match(app, /function paintDevicesDisabled\(/);
    assert.match(app, /data\.warning/);
    assert.match(app, /\$\(["']#devicesDisabledBanner["']\)/);
    assert.match(app, /state-error/);
    assert.match(html, /id="devicesDisabledBanner"/);
    assert.match(html, /id="httpCertChip"/);
    assert.match(html, /id="uptimeBar30"/);
    assert.match(app, /class="btn btn-secondary device-ping"/);
    assert.match(app, /class="btn btn-secondary device-traceroute"/);
    assert.match(html, /id="connResolveDns"/);
    assert.match(app, /wireChartTip\(usageTrendChart/);
    assert.match(html, /<th scope="col"[^>]*data-tip="dev-cat"/);
    assert.match(html, /<th scope="col"[^>]*data-tip="conn-service"/);
    assert.match(html, /data-tip="stat-30d"/);
    assert.match(html, /data-tip="http-cert"/);
    assert.match(html, /<th scope="col"[^>]*data-tip="usage-app"/);
    assert.match(html, /<th scope="col"[^>]*data-tip="hist-type"/);
    assert.match(html, /<th scope="col"[^>]*data-tip="topo-nb"/);
  });
});
