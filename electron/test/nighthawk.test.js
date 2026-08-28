"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  testConnection,
  getClients,
  getRouterHealth,
  setRequestFn,
  resetForTest,
} = require("../nighthawk");

afterEach(() => {
  resetForTest();
});

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

const ATTACH2 = soapOk(
  "GetAttachDevice2",
  `<NewAttachDevice>
    <Device>
      <IP>192.168.1.20</IP>
      <Name>Phone</Name>
      <MAC>AA:BB:CC:DD:EE:FF</MAC>
      <ConnectionType>5GHz</ConnectionType>
      <SSID>HomeWiFi</SSID>
      <LinkRate>866</LinkRate>
      <SignalStrength>100</SignalStrength>
      <ConnAPMAC>11:22:33:44:55:66</ConnAPMAC>
    </Device>
    <Device>
      <IP>192.168.1.21</IP>
      <Name>Desktop</Name>
      <MAC>AA:BB:CC:DD:EE:01</MAC>
      <ConnectionType>wired</ConnectionType>
      <LinkRate>1000</LinkRate>
      <SignalStrength>100</SignalStrength>
    </Device>
    <Device>
      <IP>192.168.1.22</IP>
      <Name>Laptop</Name>
      <MAC>AA:BB:CC:DD:EE:02</MAC>
      <ConnectionType>2.4GHz</ConnectionType>
      <SignalStrength>-67</SignalStrength>
      <LinkRate>72</LinkRate>
    </Device>
  </NewAttachDevice>`
);

const ATTACH1 = soapOk(
  "GetAttachDevice",
  `<NewAttachDevice>2@1;192.168.1.30;Tablet;AA:BB:CC:00:00:01;5GHz;400;100;Allow@2;192.168.1.31;Nas;AA:BB:CC:00:00:02;wired;1000;;Allow</NewAttachDevice>`
);

const INFO = soapOk(
  "GetInfo",
  `<ModelName>R7000</ModelName><Firmwareversion>V1.0.11.136</Firmwareversion>`
);

function loginThen(handler) {
  return async (url, init) => {
    const action = soapAction(init);
    if (action.endsWith("#SOAPLogin")) {
      return {
        status: 200,
        headers: { "set-cookie": "SOAPSESSION=abc123" },
        body: soapOk("SOAPLogin"),
      };
    }
    return handler(url, init, action);
  };
}

describe("nighthawk SOAP adapter", () => {
  it("rejects a public router_host before any HTTP", async () => {
    let calls = 0;
    setRequestFn(async () => {
      calls += 1;
      return { status: 200, body: "" };
    });
    const r = await testConnection({ host: "8.8.8.8", password: "secret" });
    assert.equal(r.ok, false);
    assert.match(r.error, /private or local IP/i);
    assert.equal(calls, 0);
    const clients = await getClients({ host: "1.1.1.1", password: "secret" });
    assert.equal(clients.ok, false);
    assert.deepEqual(clients.clients, []);
    assert.equal(calls, 0);
  });

  it("testConnection with blank port tries 5000 then 80", async () => {
    const urls = [];
    setRequestFn(
      loginThen(async (url, _init, action) => {
        urls.push(url);
        if (url.includes(":5000/")) {
          throw new Error("connect ECONNREFUSED");
        }
        if (action.endsWith("#GetInfo")) {
          return { status: 200, body: INFO };
        }
        return { status: 500, body: "" };
      })
    );
    const r = await testConnection({ host: "192.168.1.1", password: "secret" });
    assert.equal(r.ok, true);
    assert.equal(r.model, "R7000");
    assert.equal(r.firmware, "V1.0.11.136");
    assert.ok(urls.some((u) => u.includes(":5000/")));
    assert.ok(urls.some((u) => u.includes(":80/")));
    assert.ok(
      urls.findIndex((u) => u.includes(":5000/")) < urls.findIndex((u) => u.includes(":80/"))
    );
  });

  it("logs in with SOAPLogin then parses GetAttachDevice2; signal 100 is percent not RSSI", async () => {
    const actions = [];
    let cookieOnAttach = false;
    setRequestFn(async (_url, init) => {
      const action = soapAction(init);
      actions.push(action);
      if (action.endsWith("#SOAPLogin")) {
        return {
          status: 200,
          headers: { "set-cookie": "SOAPSESSION=abc123" },
          body: soapOk("SOAPLogin"),
        };
      }
      if (action.endsWith("#GetAttachDevice2")) {
        cookieOnAttach = !!(init.headers && init.headers.Cookie);
        return { status: 200, body: ATTACH2 };
      }
      return { status: 500, body: "" };
    });
    const r = await getClients({ host: "192.168.1.1", user: "admin", password: "secret" });
    assert.equal(r.ok, true);
    assert.equal(actions[0].endsWith("#SOAPLogin"), true);
    assert.ok(actions.some((a) => a.endsWith("#GetAttachDevice2")));
    assert.ok(!actions.some((a) => a.endsWith("#Authenticate")));
    assert.equal(cookieOnAttach, true);

    const phone = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:FF");
    assert.ok(phone);
    assert.equal(phone.signal_pct, 100);
    assert.equal(phone.rssi, null);
    assert.equal(phone.band, "5");
    assert.equal(phone.ssid, "HomeWiFi");
    assert.equal(phone.tx_mbps, 866);
    assert.equal(phone.node_mac, "11:22:33:44:55:66");
    assert.equal(phone.online, true);

    const wired = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:01");
    assert.equal(wired.band, "wired");
    assert.equal(wired.signal_pct, null);
    assert.equal(wired.rssi, null);
    assert.equal(wired.tx_mbps, 1000);
    assert.equal(wired.ssid, null);

    const laptop = r.clients.find((c) => c.mac === "AA:BB:CC:DD:EE:02");
    assert.equal(laptop.rssi, -67);
    assert.equal(laptop.signal_pct, null);
    assert.equal(laptop.band, "2.4");
  });

  it("falls back from GetAttachDevice2 404 to GetAttachDevice", async () => {
    const actions = [];
    setRequestFn(
      loginThen(async (_url, _init, action) => {
        actions.push(action);
        if (action.endsWith("#GetAttachDevice2")) {
          return { status: 404, body: soapOk("GetAttachDevice2", "", "404") };
        }
        if (action.endsWith("#GetAttachDevice")) {
          return { status: 200, body: ATTACH1 };
        }
        return { status: 500, body: "" };
      })
    );
    const r = await getClients({ host: "192.168.1.1", password: "secret" });
    assert.equal(r.ok, true);
    assert.ok(actions.some((a) => a.endsWith("#GetAttachDevice2")));
    assert.ok(actions.some((a) => a.endsWith("#GetAttachDevice")));
    const tab = r.clients.find((c) => c.mac === "AA:BB:CC:00:00:01");
    assert.equal(tab.signal_pct, 100);
    assert.equal(tab.rssi, null);
    assert.equal(tab.band, "5");
    const nas = r.clients.find((c) => c.mac === "AA:BB:CC:00:00:02");
    assert.equal(nas.band, "wired");
    assert.equal(nas.signal_pct, null);

    actions.length = 0;
    const again = await getClients({ host: "192.168.1.1", password: "secret" });
    assert.equal(again.ok, true);
    assert.ok(!actions.some((a) => a.endsWith("#GetAttachDevice2")));
    assert.ok(actions.some((a) => a.endsWith("#GetAttachDevice")));
  });

  it("getRouterHealth uses GetInfo and skips GetSystemInfo after 404", async () => {
    const actions = [];
    setRequestFn(
      loginThen(async (_url, _init, action) => {
        actions.push(action);
        if (action.endsWith("#GetInfo")) return { status: 200, body: INFO };
        if (action.endsWith("#GetSystemInfo")) {
          return { status: 404, body: soapOk("GetSystemInfo", "", "404") };
        }
        if (action.endsWith("#GetEthernetLinkStatus")) {
          return {
            status: 200,
            body: soapOk("GetEthernetLinkStatus", `<NewEthernetLinkStatus>Up</NewEthernetLinkStatus>`),
          };
        }
        if (action.endsWith("#GetExternalIPAddress")) {
          return {
            status: 200,
            body: soapOk("GetExternalIPAddress", `<NewExternalIPAddress>203.0.113.4</NewExternalIPAddress>`),
          };
        }
        return { status: 500, body: "" };
      })
    );
    const h = await getRouterHealth({ host: "192.168.1.1", password: "secret" });
    assert.equal(h.ok, true);
    assert.equal(h.model, "R7000");
    assert.equal(h.firmware, "V1.0.11.136");
    assert.equal(h.cpu_pct, null);
    assert.equal(h.wan_ok, true);
    assert.equal(h.wan_ip, "203.0.113.4");
    assert.ok(actions.some((a) => a.endsWith("#GetSystemInfo")));

    actions.length = 0;
    const h2 = await getRouterHealth({ host: "192.168.1.1", password: "secret" });
    assert.equal(h2.ok, true);
    assert.ok(!actions.some((a) => a.endsWith("#GetSystemInfo")));
    assert.ok(actions.some((a) => a.endsWith("#GetInfo")));
  });
});
