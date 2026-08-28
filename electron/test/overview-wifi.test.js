"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { pickOverviewWifi } = require("../overview-wifi");

const DEVICES = [
  {
    mac: "aa:bb:cc:dd:ee:01",
    online: true,
    wifi_ssid: "Home",
    wifi_rssi: -50,
    wifi_signal_pct: 80,
    wifi_band: "5",
  },
  {
    mac: "aa:bb:cc:dd:ee:02",
    online: true,
    wifi_ssid: "Home",
    wifi_rssi: -70,
    wifi_band: "2.4",
  },
  {
    mac: "aa:bb:cc:dd:ee:03",
    online: true,
    wifi_ssid: "Guest",
    wifi_rssi: -62,
    wifi_band: "5",
  },
  {
    mac: "aa:bb:cc:00:00:99",
    online: true,
    wifi_band: "wired",
    wifi_ssid: null,
  },
];

describe("pickOverviewWifi", () => {
  it("wifi NIC uses this PC’s radio, not router client SSIDs", () => {
    const got = pickOverviewWifi({
      adapter: { type: "wifi", ssid: "Cafe", rssi: -44, signal: 90, band: "5", mac: "11:22:33:44:55:66" },
      devices: DEVICES,
      host_adapter: { mac: "11:22:33:44:55:66", ssid: "Cafe" },
      pollEnabled: true,
      source: "asus",
    });
    assert.equal(got.source, "host_nic");
    assert.equal(got.ssid, "Cafe");
    assert.equal(got.rssi, -44);
    assert.equal(got.signal_pct, 90);
    assert.equal(got.this_pc_on_wifi, true);
    assert.equal(got.client_count, 3);
  });

  it("ethernet + poll: network SSID/clients; MAC match is this-PC RSSI; no dBm from %", () => {
    const net = pickOverviewWifi({
      adapter: { type: "ethernet", name: "Ethernet", mac: "00:11:22:33:44:55" },
      devices: DEVICES,
      host_adapter: { mac: "00:11:22:33:44:55", type: "ethernet" },
      pollEnabled: true,
      extra: { ssid: "ShouldNotWin" },
      source: "nighthawk",
    });
    assert.equal(net.source, "nighthawk");
    assert.equal(net.ssid, "Home");
    assert.equal(net.this_pc_on_wifi, false);
    assert.equal(net.rssi, null);
    assert.equal(net.client_count, 3);
    assert.equal(net.weakest_rssi, -70);
    assert.equal(net.median_rssi, -62);

    const dual = pickOverviewWifi({
      adapter: { type: "ethernet", mac: "aa:bb:cc:dd:ee:01" },
      devices: DEVICES,
      host_adapter: { mac: "AA-BB-CC-DD-EE-01" },
      pollEnabled: true,
      source: "unifi",
    });
    assert.equal(dual.this_pc_on_wifi, true);
    assert.equal(dual.rssi, -50);
    assert.equal(dual.signal_pct, 80);
    assert.equal(dual.band, "5");
    assert.equal(dual.ssid, "Home");

    const pctOnly = pickOverviewWifi({
      adapter: { type: "ethernet" },
      devices: [
        { mac: "aa:aa:aa:aa:aa:01", online: true, wifi_ssid: "Home", wifi_signal_pct: 40, wifi_band: "5" },
        { mac: "aa:aa:aa:aa:aa:02", online: true, wifi_ssid: "Home", wifi_signal_pct: 90, wifi_band: "5" },
      ],
      host_adapter: { mac: null },
      pollEnabled: true,
      source: "omada",
    });
    assert.equal(pctOnly.ssid, "Home");
    assert.equal(pctOnly.client_count, 2);
    assert.equal(pctOnly.weakest_rssi, null);
    assert.equal(pctOnly.median_rssi, null);
    assert.equal(pctOnly.rssi, null);
    const extraOnly = pickOverviewWifi({
      adapter: { type: "ethernet" },
      devices: [],
      host_adapter: {},
      pollEnabled: true,
      extra: { ssid: "FromExtra" },
      source: "asus",
    });
    assert.equal(extraOnly.ssid, "FromExtra");
    assert.equal(extraOnly.client_count, 0);
    assert.equal(extraOnly.source, "asus");
  });

  it("poll off + ethernet is empty (no fake SSID)", () => {
    const got = pickOverviewWifi({
      adapter: { type: "ethernet", name: "Ethernet" },
      devices: DEVICES,
      host_adapter: { ssid: "Home" },
      pollEnabled: false,
      extra: { ssid: "Home" },
      source: "asus",
    });
    assert.equal(got, null);
  });
});
