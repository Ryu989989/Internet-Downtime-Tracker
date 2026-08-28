"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TrackerDb, DEFAULT_SETTINGS, parseRouterTargetsJson } = require("../db");
const { createAdapter, vendorWriteSupport } = require("../router-adapter");
const lanBridge = require("../lan-bridge");
const asuswrt = require("../asuswrt");
const nighthawk = require("../nighthawk");
const unifi = require("../unifi");
const omada = require("../omada");

const MAC = "AA:BB:CC:DD:EE:FF";

function fnSource(mod, name) {
  assert.equal(typeof mod[name], "function", name);
  return Function.prototype.toString.call(mod[name]);
}

function soapAction(init) {
  return (init && init.headers && init.headers.SOAPAction) || "";
}

function soapOk(method, inner, code = "0") {
  return (
    `<?xml version="1.0"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<SOAP-ENV:Body>` +
    `<${method}Response>` +
    `<ResponseCode>${code}</ResponseCode>` +
    `${inner || ""}` +
    `</${method}Response>` +
    `</SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

describe("router writes", () => {
  let dir;
  let db;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-router-writes-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    lanBridge.resetRouterPollForTest();
    lanBridge.init({ db, monitor: null });
    lanBridge.setRouterPollForTest({
      getDefaultGateway: async () => "192.168.1.1",
    });
    db.updateSettings({
      router_poll_enabled: true,
      router_vendor: "asuswrt",
      router_host: "192.168.1.1",
      router_user: "admin",
      router_password: "wifi-secret",
    });
  });

  afterEach(async () => {
    lanBridge.resetRouterPollForTest();
    lanBridge.shutdown();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    asuswrt.resetRequestFn();
    nighthawk.resetForTest();
    unifi.resetRequestFn();
    omada.resetRequestFn();
  });

  it("defaults off; IPC rejects flag/confirm/public host; audits without secrets", async () => {
    assert.equal(DEFAULT_SETTINGS.router_writes_enabled, false);
    assert.equal(db.getSettings().router_writes_enabled, false);

    const off = await lanBridge.routerAction({
      action: "setClientBlocked",
      mac: MAC,
      blocked: true,
      confirm: MAC,
    });
    assert.equal(off.ok, false);
    assert.match(off.error, /disabled/i);

    db.updateSettings({ router_writes_enabled: true });
    const noConfirm = await lanBridge.routerAction({
      action: "setClientBlocked",
      mac: MAC,
      blocked: true,
    });
    assert.equal(noConfirm.ok, false);
    assert.match(noConfirm.error, /confirm/i);

    const badConfirm = await lanBridge.routerAction({
      action: "setClientBlocked",
      mac: MAC,
      blocked: true,
      confirm: "nope",
    });
    assert.equal(badConfirm.ok, false);
    assert.match(badConfirm.error, /confirm/i);

    db.updateSettings({ router_host: "8.8.8.8" });
    const pub = await lanBridge.routerAction({
      action: "setClientBlocked",
      mac: MAC,
      blocked: true,
      confirm: MAC,
    });
    assert.equal(pub.ok, false);
    assert.match(pub.error, /private or local/i);

    const rows = db.listRouterActions({ limit: 20 });
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((r) => r.ok === 0));
    const blob = JSON.stringify(rows);
    assert.doesNotMatch(blob, /wifi-secret/);
    assert.doesNotMatch(blob, /password=/i);
  });

  it("confirm mac/block/band; fake adapter + audit ok", async () => {
    const seen = [];
    lanBridge.setRouterPollForTest({
      createAdapter: () => ({
        setClientBlocked: async (opts) => {
          seen.push(["block", opts.mac, opts.blocked]);
          return { ok: true };
        },
        setGuestWifi: async (opts) => {
          seen.push(["guest", opts.band, opts.enabled]);
          return { ok: true };
        },
      }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    db.updateSettings({ router_writes_enabled: true, router_host: "192.168.1.1" });

    const a = await lanBridge.routerAction({
      action: "setClientBlocked",
      mac: MAC.toLowerCase(),
      blocked: true,
      confirm: "block",
    });
    assert.equal(a.ok, true);
    const b = await lanBridge.routerAction({
      action: "setClientBlocked",
      mac: MAC,
      blocked: false,
      confirm: MAC,
    });
    assert.equal(b.ok, true);
    const c = await lanBridge.routerAction({
      action: "setGuestWifi",
      band: "5",
      enabled: true,
      confirm: "5",
    });
    assert.equal(c.ok, true);
    assert.equal(seen.length, 3);
    const okRows = db.listRouterActions().filter((r) => r.ok === 1);
    assert.ok(okRows.length >= 3);
  });

  it("vendorWriteSupport; write helpers have no reboot/firmware", () => {
    assert.equal(wifiSampleSafe(), true);
    for (const v of ["asuswrt", "nighthawk", "unifi", "omada"]) {
      const caps = vendorWriteSupport(v);
      assert.equal(caps.setClientBlocked, true, v);
      assert.equal(caps.setGuestWifi, v !== "omada", v);
      const mod = createAdapter(v);
      const src = fnSource(mod, "setClientBlocked");
      assert.doesNotMatch(src, /reboot/i);
      assert.doesNotMatch(src, /firmware/i);
      if (caps.setGuestWifi) {
        const g = fnSource(mod, "setGuestWifi");
        assert.doesNotMatch(g, /reboot/i);
        assert.doesNotMatch(g, /firmware/i);
      } else {
        assert.equal(typeof mod.setGuestWifi, "undefined");
      }
    }
    const parsed = parseRouterTargetsJson(
      JSON.stringify([{ id: "u1", vendor: "unifi", host: "192.168.1.1", user: "admin", enabled: true }])
    );
    assert.equal(parsed[0].vendor, "unifi");
  });

  it("ASUS applyapp block/guest; Nighthawk SOAP; UniFi stamgr; Omada block", async () => {
    const asusPaths = [];
    asuswrt.setRequestFn(async (url, init) => {
      const p = new URL(url).pathname;
      asusPaths.push(p);
      if (p.endsWith("/login.cgi")) {
        return { status: 200, headers: { "set-cookie": "asus_token=tok; Path=/" }, body: "ok" };
      }
      if (p.endsWith("/appGet.cgi")) {
        return { status: 200, headers: {}, body: "MULTIFILTER_MAC=;MULTIFILTER_ENABLE=;MULTIFILTER_DEVICENAME=;MULTIFILTER_MACFILTER_DAYTIME=;MULTIFILTER_ALL=0;" };
      }
      if (p.endsWith("/applyapp.cgi")) {
        const body = String((init && init.body) || "");
        assert.doesNotMatch(body, /reboot/i);
        assert.doesNotMatch(body, /firmware/i);
        if (/wl0\.1_bss_enabled=1/.test(body)) {
          assert.match(body, /restart_wireless/);
          return { status: 200, headers: {}, body: "ok" };
        }
        assert.match(body, /MULTIFILTER_MAC=/);
        assert.match(body, /restart_firewall/);
        assert.match(decodeURIComponent(body.replace(/\+/g, " ")), /AA:BB:CC:DD:EE:FF/);
        return { status: 200, headers: {}, body: "ok" };
      }
      throw new Error("unexpected " + p);
    });
    const ab = await asuswrt.setClientBlocked({
      host: "192.168.1.1",
      user: "admin",
      password: "secret",
      mac: MAC,
      blocked: true,
    });
    assert.equal(ab.ok, true);
    assert.ok(asusPaths.some((p) => p.endsWith("/applyapp.cgi")));
    const ag = await asuswrt.setGuestWifi({
      host: "192.168.1.1",
      user: "admin",
      password: "secret",
      band: "2.4",
      enabled: true,
    });
    assert.equal(ag.ok, true);

    const soapMethods = [];
    nighthawk.setRequestFn(async (_url, init) => {
      const action = soapAction(init);
      soapMethods.push(action.split("#")[1] || action);
      if (action.endsWith("#SOAPLogin")) {
        return { status: 200, headers: { "set-cookie": "SOAPSESSION=x" }, body: soapOk("SOAPLogin") };
      }
      if (action.endsWith("#SetBlockDeviceEnable") || action.endsWith("#SetBlockDeviceByMAC")) {
        const xml = String((init && init.body) || "");
        if (action.endsWith("#SetBlockDeviceByMAC")) {
          assert.match(xml, /<NewAllowOrBlock>Block<\/NewAllowOrBlock>/);
          assert.match(xml, /AA:BB:CC:DD:EE:FF/);
        }
        return { status: 200, body: soapOk(action.split("#")[1]) };
      }
      if (action.endsWith("#SetGuestAccessEnabled2")) {
        return { status: 200, body: soapOk("SetGuestAccessEnabled2") };
      }
      return { status: 401, body: soapOk("Fault", "", "401") };
    });
    const nb = await nighthawk.setClientBlocked({
      host: "192.168.1.1",
      password: "secret",
      mac: MAC,
      blocked: true,
    });
    assert.equal(nb.ok, true);
    assert.ok(soapMethods.includes("SetBlockDeviceByMAC"));
    const ng = await nighthawk.setGuestWifi({
      host: "192.168.1.1",
      password: "secret",
      band: "2.4",
      enabled: true,
    });
    assert.equal(ng.ok, true);
    nighthawk.resetForTest();
    nighthawk.setRequestFn(async (_url, init) => {
      const action = soapAction(init);
      if (action.endsWith("#SOAPLogin")) {
        return { status: 200, headers: { "set-cookie": "SOAPSESSION=x" }, body: soapOk("SOAPLogin") };
      }
      return { status: 401, body: soapOk("Fault", "", "401") };
    });
    const rm = await nighthawk.setClientBlocked({
      host: "192.168.1.1",
      password: "secret",
      mac: MAC,
      blocked: true,
    });
    assert.equal(rm.ok, false);
    assert.match(rm.error, /Remote Management/i);

    const uniPaths = [];
    unifi.setRequestFn(async (url, init) => {
      const p = new URL(url).pathname;
      uniPaths.push(p);
      if (p.endsWith("/cmd/stamgr")) {
        assert.equal((init && init.method) || "GET", "POST");
        const j = JSON.parse(String((init && init.body) || "{}"));
        assert.equal(j.cmd, "block-sta");
        assert.equal(j.mac, MAC.toLowerCase());
        return { status: 200, headers: {}, body: JSON.stringify({ meta: { rc: "ok" }, data: [] }) };
      }
      if (p.endsWith("/rest/wlanconf")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            meta: { rc: "ok" },
            data: [{ _id: "wlan1", is_guest: true, wlan_band: "ng", enabled: false, name: "Guest" }],
          }),
        };
      }
      if (p.endsWith("/rest/wlanconf/wlan1")) {
        const j = JSON.parse(String((init && init.body) || "{}"));
        assert.equal(j.enabled, true);
        assert.equal(j.name, undefined);
        return { status: 200, headers: {}, body: JSON.stringify({ meta: { rc: "ok" }, data: [] }) };
      }
      throw new Error("unexpected " + p);
    });
    const ub = await unifi.setClientBlocked({
      host: "192.168.1.1",
      api_key: "unitest-key",
      mac: MAC,
      blocked: true,
    });
    assert.equal(ub.ok, true);
    const ug = await unifi.setGuestWifi({
      host: "192.168.1.1",
      api_key: "unitest-key",
      band: "2.4",
      enabled: true,
    });
    assert.equal(ug.ok, true);

    const OMADAC = "abc123omadacid";
    const SITE = "site99";
    let blockedPath = "";
    omada.setRequestFn(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/api/info") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ errorCode: 0, result: { omadacId: OMADAC, controllerVer: "5.13.30.8" } }),
        };
      }
      if (u.pathname === `/${OMADAC}/api/v2/login`) {
        return {
          status: 200,
          headers: { "set-cookie": "TPOMADA_SESSIONID=sess; Path=/" },
          body: JSON.stringify({ errorCode: 0, result: { token: "csrf-tok" } }),
        };
      }
      if (u.pathname === `/${OMADAC}/api/v2/sites`) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ errorCode: 0, result: { data: [{ id: SITE, name: "Default" }] } }),
        };
      }
      if (/\/cmd\/clients\/[^/]+\/block$/.test(u.pathname)) {
        blockedPath = u.pathname;
        assert.equal((init && init.method) || "GET", "POST");
        return { status: 200, headers: {}, body: JSON.stringify({ errorCode: 0, result: {} }) };
      }
      throw new Error("unexpected " + u.pathname);
    });
    const ob = await omada.setClientBlocked({
      host: "192.168.0.2",
      user: "admin",
      password: "secret",
      mac: MAC,
      blocked: true,
    });
    assert.equal(ob.ok, true);
    assert.match(blockedPath, /cmd\/clients/);
    assert.equal(typeof omada.setGuestWifi, "undefined");
  });
});

function wifiSampleSafe() {
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(preload, /lanRouterAction:/);
  assert.match(main, /safeHandle\("api:lan:router:action"/);
  return true;
}
