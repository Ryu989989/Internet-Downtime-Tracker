"use strict";

/**
 * On-demand TCP port scan of one private/known host + offline CVE advisory match.
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

const TOP_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995, 1433, 1521,
  3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 27017, 5000, 5001, 8000, 8888,
  9000, 9090, 10000, 32400, 49152, 49153, 49154,
];

const CONNECT_TIMEOUT_MS = 600;
const BANNER_TIMEOUT_MS = 400;
const MAX_CONCURRENCY = 20;

/** @type {null | object[]} */
let cveCache = null;

function isPrivateOrLocalIp(host) {
  if (!host || typeof host !== "string") return false;
  const bare = host.trim().replace(/^\[|\]$/g, "");
  if (bare === "127.0.0.1" || bare === "::1" || bare === "localhost") return true;
  if (!net.isIP(bare)) return false;
  if (net.isIP(bare) === 6) {
    const lower = bare.toLowerCase();
    return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  const [a, b] = bare.split(".").map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function loadCveDb() {
  if (cveCache) return cveCache;
  const p = path.join(__dirname, "data", "cve-advisories.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    cveCache = Array.isArray(raw) ? raw : raw.items || [];
  } catch {
    cveCache = [];
  }
  return cveCache;
}

function probePort(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    let banner = "";
    const finish = (open) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve({
        port,
        open: !!open,
        banner: banner ? banner.slice(0, 120) : null,
      });
    };
    const t = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    sock.on("connect", () => {
      clearTimeout(t);
      sock.setTimeout(BANNER_TIMEOUT_MS);
      sock.once("data", (buf) => {
        banner = buf.toString("utf8").replace(/[^\x20-\x7E]/g, " ").trim();
        finish(true);
      });
      sock.once("timeout", () => finish(true));
      // Nudge some services
      try {
        sock.write("\r\n");
      } catch {
        finish(true);
      }
    });
    sock.on("error", () => {
      clearTimeout(t);
      finish(false);
    });
  });
}

async function mapPool(items, limit, fn) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function matchCves(openPorts) {
  const db = loadCveDb();
  const hits = [];
  for (const row of openPorts) {
    if (!row.open) continue;
    for (const adv of db) {
      const ports = adv.ports || [];
      const bannerRe = adv.banner_re ? new RegExp(adv.banner_re, "i") : null;
      const portHit = ports.includes(row.port);
      const bannerHit = bannerRe && row.banner && bannerRe.test(row.banner);
      if (portHit || bannerHit) {
        hits.push({
          port: row.port,
          cve: adv.cve || adv.id,
          severity: adv.severity || "unknown",
          summary: adv.summary || "",
          advisory: true,
          stale: !!adv.stale,
        });
      }
    }
  }
  return hits;
}

/**
 * @param {{ host: string, ports?: number[], onProgress?: (p: object) => void, signal?: { cancelled?: boolean } }} opts
 */
async function scanHost(opts = {}) {
  const host = String(opts.host || "").trim();
  if (!isPrivateOrLocalIp(host)) {
    return { ok: false, error: "Target must be a private/local IP", ports: [], cves: [] };
  }
  const ports = (opts.ports && opts.ports.length ? opts.ports : TOP_PORTS).slice(0, 100);
  const results = [];
  let done = 0;
  await mapPool(ports, MAX_CONCURRENCY, async (port) => {
    if (opts.signal && opts.signal.cancelled) {
      return { port, open: false, banner: null, skipped: true };
    }
    const r = await probePort(host, port);
    done += 1;
    if (opts.onProgress) {
      try {
        opts.onProgress({ done, total: ports.length, last: r });
      } catch {
        /* ignore */
      }
    }
    results.push(r);
    return r;
  });
  const open = results.filter((r) => r.open);
  const cves = matchCves(open);
  return {
    ok: true,
    host,
    ports: results.sort((a, b) => a.port - b.port),
    open_ports: open.map((r) => r.port),
    cves,
    disclaimer: "CVE matches are advisory/offline and may be stale — not a full vuln assessment.",
  };
}

module.exports = {
  TOP_PORTS,
  isPrivateOrLocalIp,
  loadCveDb,
  matchCves,
  scanHost,
  probePort,
};
