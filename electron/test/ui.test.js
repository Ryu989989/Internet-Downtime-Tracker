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

  it("widget.html is loadFile-safe (no remote script)", () => {
    const html = fs.readFileSync(path.join(repoRoot, "web", "widget.html"), "utf8");
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
    assert.match(html, /<script[^>]+src="widget\.js"/);
  });
});
