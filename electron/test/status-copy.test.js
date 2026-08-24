"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { statusHeadline, layerPills } = require("../status-copy");

describe("statusHeadline", () => {
  it("paused", () => {
    assert.deepEqual(statusHeadline({ paused: true, lan_ok: false }), {
      title: "Paused",
      sub: "Monitoring is paused. Resume from Settings or the tray",
    });
  });

  it("lan down", () => {
    assert.deepEqual(statusHeadline({ lan_ok: false, wan_ok: false }), {
      title: "LAN down",
      sub: "Gateway unreachable. A local network issue is likely",
    });
  });

  it("all clear", () => {
    assert.deepEqual(
      statusHeadline({ lan_ok: true, wan_ok: true, dns_ok: true, http_ok: true }),
      { title: "All clear", sub: "LAN, WAN, DNS, and HTTP path OK" }
    );
  });

  it("warmup", () => {
    assert.deepEqual(statusHeadline({}), {
      title: "Warming up",
      sub: "Waiting for first probe results",
    });
  });
});

describe("layerPills", () => {
  it("LAN down uses WAN amber, not down styling, and blanks DNS/HTTP", () => {
    const pills = layerPills({ lan_ok: false, wan_ok: false, dns_ok: false, http_ok: false });
    assert.equal(pills.lan.kind, "down");
    assert.equal(pills.wan.kind, "amber");
    assert.equal(pills.wan.text, "WAN DOWN");
    assert.equal(pills.dns.kind, "unknown");
    assert.equal(pills.dns.text, "DNS -");
    assert.equal(pills.http.kind, "unknown");
    assert.equal(pills.http.text, "HTTP -");
  });

  it("unknown keys stay off the pill map", () => {
    const pills = layerPills({ lan_ok: true, wan_ok: true, dns_ok: true, http_ok: true });
    assert.equal(pills.lan.kind, "ok");
    assert.equal(pills.http.kind, "ok");
    assert.equal(pills.bogus, undefined);
  });
});
