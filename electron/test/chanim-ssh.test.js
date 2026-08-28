"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_IFACES,
  parseIfaceList,
  parseChanimStats,
  collectChanim,
  mergeChanimExtra,
  setRunSshForTest,
  resetRunSshForTest,
} = require("../chanim-ssh");
const { parseRouterTargetsJson, TrackerDb } = require("../db");
const { renderPrometheus } = require("../metrics-api");
const lanBridge = require("../lan-bridge");

const TABLE_BLOB = `Version: 3
chanspec tx rx inbss obss nocat nopkt doze txop goodtx badtx glitch badplcp knoise idle timestamp
0xd032 5 3 12 1 0 0 0 0 0 0 0 0 -91 78 1690000000
`;

const KV_BLOB = `chanspec: 0xe09b
tx: 1
rx: 4
inbss: 3
knoise: -91
idle: 95
`;

function fakeAdapter() {
  return {
    testConnection: async () => ({ ok: true, model: "RT-AX86U" }),
    getClients: async () => ({ ok: true, clients: [] }),
    getRouterHealth: async () => ({
      ok: true,
      cpu_pct: 12,
      mem_used: 100,
      mem_total: 512,
      wan_ok: true,
      wan_ip: "1.2.3.4",
      model: "RT-AX86U",
      firmware: "3.0",
      extra_json: { mem_free: 50 },
    }),
  };
}

describe("chanim parse + fail-closed SSH", () => {
  afterEach(() => {
    resetRunSshForTest();
  });

  it("parses recorded chanim_stats table and key:value blobs", () => {
    const table = parseChanimStats(TABLE_BLOB, "eth6");
    assert.equal(table.iface, "eth6");
    assert.equal(table.radio, "eth6");
    assert.equal(table.idle, 78);
    assert.equal(table.tx, 5);
    assert.equal(table.rx, 3);
    assert.equal(table.inbss, 12);
    assert.equal(table.noise, -91);
    assert.equal(table.chanspec, "0xd032");
    const kv = parseChanimStats(KV_BLOB, "eth5");
    assert.equal(kv.idle, 95);
    assert.equal(kv.tx, 1);
    assert.equal(kv.rx, 4);
    assert.equal(kv.inbss, 3);
    assert.equal(kv.noise, -91);
    assert.equal(kv.chanspec, "0xe09b");
    assert.equal(parseChanimStats("", "eth6"), null);
    assert.deepEqual(parseIfaceList(""), DEFAULT_IFACES);
    assert.deepEqual(parseIfaceList("eth6, wl1"), ["eth6", "wl1"]);
    assert.deepEqual(parseIfaceList(["eth6", "bad iface", "eth6"]), ["eth6"]);
  });

  it("fail closed: public host, non-asus, missing ssh, unreadable/PEM key; no password argv", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return TABLE_BLOB;
    };
    const pub = await collectChanim({
      vendor: "asuswrt",
      host: "8.8.8.8",
      ssh_key_path: "k",
      runner,
      keyReadable: () => true,
    });
    assert.equal(pub.ok, false);
    assert.match(pub.error, /private or local/i);
    const vend = await collectChanim({
      vendor: "nighthawk",
      host: "192.168.1.1",
      ssh_key_path: "k",
      runner,
      keyReadable: () => true,
    });
    assert.equal(vend.ok, false);
    assert.match(vend.error, /ASUS\/Merlin/i);
    const miss = await collectChanim({
      vendor: "asuswrt",
      host: "192.168.1.1",
      ssh_key_path: "k",
      keyReadable: () => true,
      sshExists: () => false,
    });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /ssh missing/i);
    const unread = await collectChanim({
      vendor: "asuswrt",
      host: "192.168.1.1",
      ssh_key_path: path.join(os.tmpdir(), "idt-no-such-key"),
      runner,
    });
    assert.equal(unread.ok, false);
    assert.match(unread.error, /unreadable/i);
    const pem = await collectChanim({
      vendor: "asuswrt",
      host: "192.168.1.1",
      ssh_key_path: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
      runner,
      keyReadable: () => true,
    });
    assert.equal(pem.ok, false);
    assert.equal(calls, 0);
  });

  it("injected runner collects working ifaces and uses BatchMode key SSH", async () => {
    const seen = [];
    const r = await collectChanim({
      vendor: "asuswrt",
      host: "192.168.1.1",
      user: "admin",
      ssh_key_path: "/tmp/id_ed25519",
      keyReadable: () => true,
      runner: async (call) => {
        seen.push(call);
        const dash = call.argv.indexOf("--");
        const iface = call.argv[dash + 3];
        if (iface === "eth6") return TABLE_BLOB;
        if (iface === "eth5") return KV_BLOB;
        if (iface === "wl1") return "no stats";
        const err = new Error("fail");
        err.code = "ERR_SSH";
        throw err;
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.chanim.length, 2);
    assert.equal(r.chanim[0].iface, "eth6");
    assert.equal(r.chanim[0].idle, 78);
    assert.equal(r.chanim[1].iface, "eth5");
    assert.equal(r.chanim[1].idle, 95);
    assert.equal(seen.length, 4);
    const argv = seen[0].argv;
    assert.equal(seen[0].bin, "ssh");
    assert.equal(argv[0], "-i");
    assert.equal(argv[1], "/tmp/id_ed25519");
    assert.ok(argv.includes("BatchMode=yes"));
    assert.ok(argv.includes("StrictHostKeyChecking=accept-new"));
    assert.ok(argv.includes("admin@192.168.1.1"));
    assert.ok(argv.includes("--"));
    assert.doesNotMatch(argv.join(" "), /password/i);
    const dash = argv.indexOf("--");
    assert.deepEqual(argv.slice(dash), ["--", "wl", "-i", "eth6", "chanim_stats"]);
  });

  it("stores ssh_user/ssh_key_path/ssh_ifaces on asuswrt targets only", () => {
    const parsed = parseRouterTargetsJson([
      {
        id: "a",
        vendor: "asuswrt",
        host: "192.168.1.1",
        user: "admin",
        ssh_user: "merlin",
        ssh_key_path: "C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519",
        ssh_ifaces: "eth6,eth5",
        enabled: true,
      },
      {
        id: "n",
        vendor: "nighthawk",
        host: "192.168.1.2",
        ssh_key_path: "should-drop",
        ssh_ifaces: "eth6",
        enabled: true,
      },
    ]);
    assert.equal(parsed[0].ssh_user, "merlin");
    assert.match(parsed[0].ssh_key_path, /id_ed25519/);
    assert.equal(parsed[0].ssh_ifaces, "eth6,eth5");
    assert.equal(parsed[1].ssh_key_path, undefined);
    assert.equal(parsed[1].ssh_ifaces, undefined);
    const extra = mergeChanimExtra({ mem_free: 1 }, [{ iface: "eth6", radio: "eth6", idle: 80 }]);
    assert.equal(extra.mem_free, 1);
    assert.equal(extra.chanim[0].idle, 80);
  });
});

describe("chanim poll merge + Prom", () => {
  let dir;
  let db;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-chanim-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
    const keyPath = path.join(dir, "id_ed25519");
    fs.writeFileSync(keyPath, "ssh-ed25519 AAAA not-a-secret-blob\n");
    lanBridge.resetRouterPollForTest();
    lanBridge.init({ db, monitor: null });
    lanBridge.setRouterPollForTest({
      createAdapter: () => fakeAdapter(),
      getActiveAdapter: async () => ({ mac: null }),
      getDefaultGateway: async () => "192.168.1.1",
    });
    setRunSshForTest(async (call) => {
      const dash = call.argv.indexOf("--");
      const iface = call.argv[dash + 3];
      if (iface === "eth6") return TABLE_BLOB;
      return "";
    });
    db.updateSettings({
      router_poll_enabled: true,
      router_targets_json: JSON.stringify([
        {
          id: "default",
          vendor: "asuswrt",
          host: "192.168.1.1",
          user: "admin",
          ssh_key_path: keyPath,
          ssh_ifaces: "eth6,eth5",
          enabled: true,
        },
      ]),
      router_secrets_json: JSON.stringify({ default: { password: "x", api_key: "" } }),
    });
  });

  afterEach(async () => {
    resetRunSshForTest();
    lanBridge.stopRouterPoll();
    lanBridge.resetRouterPollForTest();
    lanBridge.shutdown();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("merges chanim into extra_json after ASUS health poll", async () => {
    await lanBridge.pollRouterOnce();
    const sample = db.getLatestRouterHealth();
    const extra = JSON.parse(sample.extra_json);
    assert.equal(extra.host, "192.168.1.1");
    assert.equal(extra.target_id, "default");
    assert.equal(extra.chanim.length, 1);
    assert.equal(extra.chanim[0].iface, "eth6");
    assert.equal(extra.chanim[0].idle, 78);
    const health = lanBridge.getRouterHealth();
    assert.equal(health.chanim[0].idle, 78);
    const body = renderPrometheus({
      devices_online: 0,
      outages_open: 0,
      outages_total: 0,
      router_targets: [{ vendor: "asuswrt", host: extra.host, chanim: extra.chanim }],
      wifi: [],
    });
    assert.match(body, /idt_wifi_chanim_idle_pct\{radio="eth6",host="192.168.1.1"\} 78/);
  });
});
