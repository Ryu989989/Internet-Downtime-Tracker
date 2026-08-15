"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const dns = require("node:dns");
const {
  tcpConnect,
  summarizePingBurst,
  isMonitorStale,
  checkHttp,
  peerCertDays,
  probe,
} = require("../netcheck");

describe("netcheck", () => {
  it("tcpConnect times out on closed port", async () => {
    const [ok, lat] = await tcpConnect("127.0.0.1", 1, 500);
    assert.equal(ok, false);
    assert.equal(lat, null);
  });

  it("summarizePingBurst computes loss jitter avg last", () => {
    const q = summarizePingBurst(
      [
        { ok: true, latency_ms: 10 },
        { ok: true, latency_ms: 14 },
        { ok: false, latency_ms: null },
        { ok: true, latency_ms: 12 },
      ],
      { target: "1.1.1.1", at: 100 }
    );
    assert.equal(q.target, "1.1.1.1");
    assert.equal(q.samples, 4);
    assert.equal(q.lost, 1);
    assert.equal(q.loss_pct, 25);
    assert.equal(q.latency_ms, 12);
    assert.equal(q.latency_avg_ms, 12);
    assert.equal(q.jitter_ms, 3); // |14-10| + |12-14| / 2 = 3
    assert.equal(q.at, 100);
  });

  it("isMonitorStale when last probe older than 2× poll", () => {
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        paused: false,
        now: 1011,
      }),
      true
    );
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        paused: false,
        now: 1009,
      }),
      false
    );
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        paused: true,
        now: 2000,
      }),
      false
    );
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        probe_suppressed: true,
        now: 2000,
      }),
      false
    );
    assert.equal(isMonitorStale({ last_probe_at: null, now: 2000 }), false);
  });
});

describe("checkHttp certDays", () => {
  it("HTTP URL yields null certDays; peerCertDays math", async () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    assert.equal(peerCertDays(null), null);
    assert.equal(peerCertDays({}), null);
    assert.equal(peerCertDays({ valid_to: "Sep 11 00:00:00 2026 GMT" }, now), 30);
    assert.equal(peerCertDays({ valid_to: "Aug 11 00:00:00 2026 GMT" }, now), -1);

    const server = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      const [ok, lat, certDays] = await checkHttp({
        url: `http://127.0.0.1:${port}/`,
        timeoutMs: 1000,
      });
      assert.equal(ok, true);
      assert.equal(typeof lat, "number");
      assert.equal(certDays, null);
    } finally {
      server.close();
    }
  });

  it("HTTPS remaining days from peer cert on the same response", async () => {
    const pfx = fs.readFileSync(path.join(__dirname, "fixtures", "localhost.pfx"));
    const ca = fs.readFileSync(path.join(__dirname, "fixtures", "localhost-cert.pem"));
    const server = https.createServer({ pfx, passphrase: "idt-test" }, (_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      const [ok, lat, certDays] = await checkHttp({
        url: `https://127.0.0.1:${port}/`,
        timeoutMs: 2000,
        ca,
        rejectUnauthorized: false,
      });
      assert.equal(ok, true);
      assert.equal(typeof lat, "number");
      assert.equal(typeof certDays, "number");
      assert.ok(certDays >= 80 && certDays <= 100, `certDays=${certDays}`);
    } finally {
      server.close();
    }
  });
});

describe("probe http_cert_days", () => {
  it("LAN-down skips checkHttp; HTTPS copies certDays from one request", async () => {
    const origHttp = http.request;
    const origHttps = https.request;
    const OrigResolver = dns.promises.Resolver;
    let httpN = 0;
    let httpsN = 0;
    const ca = fs.readFileSync(path.join(__dirname, "fixtures", "localhost-cert.pem"));
    http.request = function (...args) {
      httpN += 1;
      return origHttp.apply(this, args);
    };
    https.request = function (opts, cb) {
      httpsN += 1;
      if (opts && typeof opts === "object") {
        opts = { ...opts, rejectUnauthorized: false, ca };
      }
      return origHttps.call(this, opts, cb);
    };
    dns.promises.Resolver = class {
      setServers() {}
      resolve4() {
        return Promise.resolve(["8.8.8.8"]);
      }
    };
    try {
      const down = await probe(async () => "no-such-idt-host.invalid");
      assert.equal(down.lan_ok, false);
      assert.equal(down.http_ok, false);
      assert.equal(down.http_cert_days, null);
      assert.equal(httpN, 0);
      assert.equal(httpsN, 0);

      const pfx = fs.readFileSync(path.join(__dirname, "fixtures", "localhost.pfx"));
      const server = https.createServer({ pfx, passphrase: "idt-test" }, (_req, res) => {
        res.writeHead(204);
        res.end();
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address();
      try {
        const up = await probe({
          gatewayResolver: async () => "127.0.0.1",
          wanTargets: `127.0.0.1:${port}`,
          dnsResolver: "127.0.0.1",
          httpUrl: `https://127.0.0.1:${port}/`,
        });
        assert.equal(up.lan_ok, true);
        assert.equal(up.http_ok, true);
        assert.equal(typeof up.http_cert_days, "number");
        assert.ok(up.http_cert_days >= 80 && up.http_cert_days <= 100, `http_cert_days=${up.http_cert_days}`);
        assert.equal(httpN, 0);
        assert.equal(httpsN, 1);
      } finally {
        server.close();
      }
    } finally {
      http.request = origHttp;
      https.request = origHttps;
      dns.promises.Resolver = OrigResolver;
    }
  });
});
