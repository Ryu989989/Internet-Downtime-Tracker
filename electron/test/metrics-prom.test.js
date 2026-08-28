"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { renderPrometheus, BIND_HOST } = require("../metrics-api");

describe("Prometheus router/wifi gauges", () => {
  it("emits router and wifi series with labels", () => {
    assert.equal(BIND_HOST, "127.0.0.1");
    const body = renderPrometheus({
      devices_online: 2,
      outages_open: 0,
      outages_total: 1,
      router_targets: [
        {
          vendor: "asuswrt",
          host: "192.168.1.1",
          cpu_pct: 12,
          mem_used: 100,
          mem_total: 512,
          wan_ok: true,
          chanim: [{ iface: "eth6", radio: "eth6", idle: 78 }],
        },
      ],
      wifi: [{ mac: "AA:BB:CC:DD:EE:FF", source: "asus", band: "5", rssi: -62, signal_pct: 70 }],
    });
    assert.match(body, /idt_router_cpu_pct\{vendor="asuswrt",host="192.168.1.1"\} 12/);
    assert.match(body, /idt_router_mem_ratio\{vendor="asuswrt",host="192.168.1.1"\} /);
    assert.match(body, /idt_router_wan_ok\{vendor="asuswrt",host="192.168.1.1"\} 1/);
    assert.match(body, /idt_wifi_rssi\{mac="AA:BB:CC:DD:EE:FF",source="asus",band="5"\} -62/);
    assert.match(body, /idt_wifi_signal_pct\{mac="AA:BB:CC:DD:EE:FF",source="asus",band="5"\} 70/);
    assert.match(body, /idt_wifi_chanim_idle_pct\{radio="eth6",host="192.168.1.1"\} 78/);
  });

  it("caps wifi at 50 and skips null RF", () => {
    const wifi = [];
    for (let i = 0; i < 60; i++) {
      wifi.push({
        mac: `AA:BB:CC:DD:EE:${i.toString(16).padStart(2, "0")}`.toUpperCase(),
        source: "asus",
        band: "5",
        rssi: -50 - (i % 10),
        signal_pct: 80,
      });
    }
    wifi.push({ mac: "11:22:33:44:55:66", source: "asus", band: "5", rssi: null, signal_pct: null });
    const body = renderPrometheus({ devices_online: 1, outages_open: 0, outages_total: 0, wifi });
    const rssi = body.match(/^idt_wifi_rssi\{/gm) || [];
    assert.equal(rssi.length, 50);
    assert.doesNotMatch(body, /11:22:33:44:55:66/);
    assert.match(body, /# TYPE idt_wifi_chanim_idle_pct gauge/);
    assert.doesNotMatch(body, /^idt_wifi_chanim_idle_pct\{/m);
  });
});
