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
    assert.match(html, /<th scope="col">Type<\/th>/);
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
});
