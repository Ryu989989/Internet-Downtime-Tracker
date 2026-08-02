"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const initSqlJs = require("sql.js");

const APP_DIR_NAME = "InternetDowntimeTracker";

const DEFAULT_SETTINGS = {
  poll_interval_s: 5,
  debounce_fail_count: 2,
  autostart: false,
  port: 8765, // unused in Electron; kept for Python DB compatibility
  probe_retention_days: 14,
  toast_alerts: false,
  /** When true: window close/minimize hide to tray (Quit still exits). */
  minimize_to_tray: true,
  wan_targets: "1.1.1.1:443,8.8.8.8:53",
  dns_resolver: "1.1.1.1",
  http_url: "http://connectivitycheck.gstatic.com/generate_204",
};

const SETTINGS_BOUNDS = {
  poll_interval_s: { min: 2, max: 3600 },
  debounce_fail_count: { min: 1, max: 20 },
  probe_retention_days: { min: 1, max: 365 },
  port: { min: 1, max: 65535 },
};

const OUTAGE_TYPES = new Set(["lan", "wan", "dns", "http"]);
const LIST_OUTAGES_LIMIT_MAX = 5000;

/**
 * Coerce/clamp a settings value. Returns null to reject (keep prior / skip write).
 * Rejects NaN, 0, and negatives for numeric tunables.
 */
function coerceBoolSetting(value) {
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    return null;
  }
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

/** Serialize snapshot JSON without mid-string truncation (keeps parseable JSON). */
function encodeSnapshotJson(snapshot, maxLen = 8000) {
  if (snapshot == null) return null;
  if (typeof snapshot === "string") {
    try {
      return encodeSnapshotJson(JSON.parse(snapshot), maxLen);
    } catch {
      return JSON.stringify({ note: snapshot.slice(0, Math.max(0, maxLen - 20)) }).slice(
        0,
        maxLen
      );
    }
  }
  let text = JSON.stringify(snapshot);
  if (text.length <= maxLen) return text;
  // Drop bulky nested blobs first, then shrink string fields.
  const slim = { ...snapshot };
  for (const key of Object.keys(slim)) {
    if (slim[key] && typeof slim[key] === "object") {
      slim[key] = { truncated: true };
      text = JSON.stringify(slim);
      if (text.length <= maxLen) return text;
    }
  }
  for (const key of Object.keys(slim)) {
    if (typeof slim[key] === "string" && slim[key].length > 120) {
      slim[key] = slim[key].slice(0, 120);
    }
  }
  text = JSON.stringify(slim);
  if (text.length <= maxLen) return text;
  return JSON.stringify({ truncated: true, type: slim.type || null });
}

function normalizeSettingValue(key, value) {
  if (key === "autostart" || key === "toast_alerts" || key === "minimize_to_tray") {
    return coerceBoolSetting(value);
  }
  if (key === "wan_targets" || key === "dns_resolver" || key === "http_url") {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s || s.length > 500) return null;
    if (key === "http_url") {
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      } catch {
        return null;
      }
    }
    return s;
  }
  const bounds = SETTINGS_BOUNDS[key];
  if (!bounds) return value;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

function normalizeSettingsObject(settings) {
  const out = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const norm = normalizeSettingValue(key, out[key]);
    out[key] = norm == null ? DEFAULT_SETTINGS[key] : norm;
  }
  return out;
}

function dataDir() {
  const base =
    process.env.LOCALAPPDATA ||
    path.join(require("os").homedir(), "AppData", "Local");
  const dir = path.join(base, APP_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dbPath() {
  return path.join(dataDir(), "tracker.db");
}

function wasmPath() {
  // sql.js exports block package.json; resolve main then sibling wasm.
  const main = require.resolve("sql.js");
  return path.join(path.dirname(main), "sql-wasm.wasm");
}

function rowsFromExec(result) {
  if (!result || !result.length) return [];
  const { columns, values } = result[0];
  return values.map((vals) => {
    const obj = {};
    columns.forEach((c, i) => {
      obj[c] = vals[i];
    });
    return obj;
  });
}

class TrackerDb {
  /**
   * @param {import('sql.js').Database} db
   * @param {string} filePath
   */
  constructor(db, filePath) {
    this.db = db;
    this.path = filePath;
    this._initSchema();
    this._persist();
  }

  static async open(filePath = null) {
    const SQL = await initSqlJs({
      locateFile: () => wasmPath(),
    });
    const fp = filePath || dbPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    let db;
    if (fs.existsSync(fp)) {
      db = new SQL.Database(fs.readFileSync(fp));
    } else {
      db = new SQL.Database();
    }
    return new TrackerDb(db, fp);
  }

  _persist() {
    const data = Buffer.from(this.db.export());
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.path)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, this.path);
    } catch (err) {
      // Windows cannot always rename over an existing file.
      try {
        fs.unlinkSync(this.path);
      } catch {
        /* missing */
      }
      try {
        fs.renameSync(tmp, this.path);
      } catch (err2) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err2;
      }
    }
  }

  _run(sql, params = []) {
    this.db.run(sql, params);
  }

  _all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  _get(sql, params = []) {
    const rows = this._all(sql, params);
    return rows[0] || null;
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('lan', 'wan', 'dns', 'http')),
        started_at REAL NOT NULL,
        ended_at REAL,
        duration_ms INTEGER,
        notes TEXT,
        snapshot_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outages_started ON outages(started_at);
      CREATE INDEX IF NOT EXISTS idx_outages_type ON outages(type);
      CREATE INDEX IF NOT EXISTS idx_outages_open ON outages(ended_at);

      CREATE TABLE IF NOT EXISTS probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp REAL NOT NULL,
        lan_ok INTEGER NOT NULL,
        wan_ok INTEGER NOT NULL,
        latency_ms REAL,
        dns_ok INTEGER,
        http_ok INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_probes_ts ON probes(timestamp);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS speed_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tested_at REAL NOT NULL,
        download_mbps REAL,
        upload_mbps REAL,
        ping_ms REAL,
        jitter_ms REAL,
        packet_loss REAL,
        server_name TEXT,
        server_id TEXT,
        server_location TEXT,
        isp TEXT,
        result_url TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_speed_tests_at ON speed_tests(tested_at);
    `);
    this._migrateSchema();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this._run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [
        key,
        JSON.stringify(value),
      ]);
    }
  }

  _migrateSchema() {
    // Expand outage type CHECK for DBs created before dns/http domains.
    const master = this._get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='outages'"
    );
    if (master && master.sql && !String(master.sql).includes("'dns'")) {
      this.db.exec(`
        CREATE TABLE outages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('lan', 'wan', 'dns', 'http')),
          started_at REAL NOT NULL,
          ended_at REAL,
          duration_ms INTEGER,
          notes TEXT,
          snapshot_json TEXT
        );
        INSERT INTO outages_new (id, type, started_at, ended_at, duration_ms, notes)
          SELECT id, type, started_at, ended_at, duration_ms, notes FROM outages;
        DROP TABLE outages;
        ALTER TABLE outages_new RENAME TO outages;
        CREATE INDEX IF NOT EXISTS idx_outages_started ON outages(started_at);
        CREATE INDEX IF NOT EXISTS idx_outages_type ON outages(type);
        CREATE INDEX IF NOT EXISTS idx_outages_open ON outages(ended_at);
      `);
    }

    const outageCols = new Set(
      this._all("PRAGMA table_info(outages)").map((c) => c.name)
    );
    if (!outageCols.has("snapshot_json")) {
      this._run("ALTER TABLE outages ADD COLUMN snapshot_json TEXT");
    }

    const probeCols = new Set(
      this._all("PRAGMA table_info(probes)").map((c) => c.name)
    );
    if (!probeCols.has("dns_ok")) {
      this._run("ALTER TABLE probes ADD COLUMN dns_ok INTEGER");
    }
    if (!probeCols.has("http_ok")) {
      this._run("ALTER TABLE probes ADD COLUMN http_ok INTEGER");
    }
  }

  close() {
    try {
      this._persist();
    } finally {
      this.db.close();
    }
  }

  getSettings() {
    const rows = this._all("SELECT key, value FROM settings");
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return normalizeSettingsObject(out);
  }

  updateSettings(updates) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const [key, value] of Object.entries(updates || {})) {
      if (!allowed.has(key)) continue;
      const normalized = normalizeSettingValue(key, value);
      if (normalized == null) continue;
      this._run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [key, JSON.stringify(normalized)]
      );
    }
    this._persist();
    return this.getSettings();
  }

  openOutage(outageType, startedAt = null, notes = null, snapshot = null) {
    const typ = String(outageType || "").toLowerCase();
    if (!OUTAGE_TYPES.has(typ)) {
      throw new Error(`invalid outage type: ${outageType}`);
    }
    const existing = this.getOpenOutage(typ);
    if (existing) return Number(existing.id);
    const ts = startedAt != null ? startedAt : Date.now() / 1000;
    const snap = encodeSnapshotJson(snapshot);
    this._run(
      "INSERT INTO outages (type, started_at, notes, snapshot_json) VALUES (?, ?, ?, ?)",
      [typ, ts, notes, snap]
    );
    const row = this._get("SELECT last_insert_rowid() AS id");
    this._persist();
    return Number(row.id);
  }

  updateOutageNotes(outageId, notes) {
    const id = Number(outageId);
    if (!Number.isFinite(id)) return null;
    const text = notes == null ? null : String(notes).slice(0, 2000);
    this._run("UPDATE outages SET notes=? WHERE id=?", [text, id]);
    this._persist();
    return this._get("SELECT * FROM outages WHERE id=?", [id]);
  }

  mergeOutageSnapshot(outageId, patch) {
    const id = Number(outageId);
    if (!Number.isFinite(id) || patch == null) return null;
    const row = this._get("SELECT snapshot_json FROM outages WHERE id=?", [id]);
    if (!row) return null;
    let cur = {};
    if (row.snapshot_json) {
      try {
        cur = JSON.parse(row.snapshot_json) || {};
      } catch {
        cur = {};
      }
    }
    const merged = { ...cur, ...(typeof patch === "object" ? patch : {}) };
    const text = encodeSnapshotJson(merged);
    this._run("UPDATE outages SET snapshot_json=? WHERE id=?", [text, id]);
    this._persist();
    return this._get("SELECT * FROM outages WHERE id=?", [id]);
  }

  closeOutage(outageId, endedAt = null, notes = null, snapshotPatch = null) {
    const ts = endedAt != null ? endedAt : Date.now() / 1000;
    const row = this._get(
      "SELECT started_at, notes, snapshot_json FROM outages WHERE id=?",
      [outageId]
    );
    if (!row) return;
    const durationMs = Math.max(0, Math.floor((ts - row.started_at) * 1000));
    let merged = notes;
    if (notes && row.notes) merged = `${row.notes}; ${notes}`;
    else if (row.notes && !notes) merged = row.notes;
    let snapText = row.snapshot_json || null;
    if (snapshotPatch != null) {
      let cur = {};
      if (row.snapshot_json) {
        try {
          cur = JSON.parse(row.snapshot_json) || {};
        } catch {
          cur = {};
        }
      }
      const next = {
        ...cur,
        ...(typeof snapshotPatch === "object" ? snapshotPatch : {}),
      };
      snapText = encodeSnapshotJson(next);
    }
    this._run(
      "UPDATE outages SET ended_at=?, duration_ms=?, notes=?, snapshot_json=? WHERE id=?",
      [ts, durationMs, merged, snapText, outageId]
    );
    this._persist();
  }

  getOpenOutages() {
    return this._all(
      "SELECT * FROM outages WHERE ended_at IS NULL ORDER BY started_at"
    );
  }

  getOpenOutage(outageType) {
    return this._get(
      `SELECT * FROM outages WHERE type=? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [outageType]
    );
  }

  listOutages({
    fromTs = null,
    toTs = null,
    outageType = null,
    minMs = null,
    limit = 500,
    orderBy = "started_at",
    orderDir = "DESC",
  } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("(ended_at IS NULL OR ended_at >= ?)");
      params.push(fromTs);
    }
    if (toTs != null) {
      clauses.push("started_at <= ?");
      params.push(toTs);
    }
    if (
      outageType &&
      String(outageType).toLowerCase() !== "all" &&
      outageType !== ""
    ) {
      clauses.push("type = ?");
      params.push(String(outageType).toLowerCase());
    }
    if (minMs != null) {
      clauses.push(
        "COALESCE(duration_ms, CAST((? - started_at) * 1000 AS INTEGER)) >= ?"
      );
      params.push(Date.now() / 1000, minMs);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const col =
      orderBy === "duration"
        ? "duration_ms"
        : orderBy === "type"
          ? "type"
          : "started_at";
    const direction =
      String(orderDir).toUpperCase() === "ASC" ? "ASC" : "DESC";
    const lim = Math.max(
      1,
      Math.min(LIST_OUTAGES_LIMIT_MAX, Math.trunc(Number(limit)) || 500)
    );
    params.push(lim);
    return this._all(
      `SELECT * FROM outages${where} ORDER BY ${col} ${direction} LIMIT ?`,
      params
    );
  }

  /**
   * Legacy helper retained for tests/callers. Does NOT close outages on a single
   * probe — Monitor adopts open IDs and closes via the normal 1-success path
   * after a post-resume grace tick (avoids flaky first-probe closes).
   */
  resumeOpenOutages(_resultOrLanOk, _wanOkArg = null) {
    return this.getOpenOutages();
  }

  insertProbe(lanOk, wanOk, latencyMs, ts = null, dnsOk = null, httpOk = null) {
    const t = ts != null ? ts : Date.now() / 1000;
    this._run(
      `INSERT INTO probes (timestamp, lan_ok, wan_ok, latency_ms, dns_ok, http_ok)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        t,
        lanOk ? 1 : 0,
        wanOk ? 1 : 0,
        latencyMs,
        dnsOk == null ? null : dnsOk ? 1 : 0,
        httpOk == null ? null : httpOk ? 1 : 0,
      ]
    );
    this._persist();
  }

  pruneProbes(retentionDays = null) {
    let days = retentionDays;
    if (days == null) {
      days = Number(this.getSettings().probe_retention_days ?? 14);
    }
    const cutoff = Date.now() / 1000 - days * 86400;
    this._run("DELETE FROM probes WHERE timestamp < ?", [cutoff]);
    this._persist();
    return 0;
  }

  probesSince(sinceTs) {
    return this._all(
      "SELECT * FROM probes WHERE timestamp >= ? ORDER BY timestamp",
      [sinceTs]
    );
  }

  insertSpeedTest(row) {
    this._run(
      `INSERT INTO speed_tests (
        tested_at, download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss,
        server_name, server_id, server_location, isp, result_url, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.tested_at,
        row.download_mbps,
        row.upload_mbps,
        row.ping_ms,
        row.jitter_ms,
        row.packet_loss,
        row.server_name,
        row.server_id,
        row.server_location,
        row.isp,
        row.result_url,
        row.raw_json || null,
      ]
    );
    const idRow = this._get("SELECT last_insert_rowid() AS id");
    this._persist();
    return this.getSpeedTest(idRow.id);
  }

  getSpeedTest(id) {
    return this._get("SELECT * FROM speed_tests WHERE id=?", [id]);
  }

  latestSpeedTest() {
    return this._get("SELECT * FROM speed_tests ORDER BY tested_at DESC LIMIT 1");
  }

  listSpeedTests({ fromTs = null, toTs = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("tested_at >= ?");
      params.push(fromTs);
    }
    if (toTs != null) {
      clauses.push("tested_at <= ?");
      params.push(toTs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this._all(
      `SELECT * FROM speed_tests ${where} ORDER BY tested_at DESC LIMIT ${lim}`,
      params
    );
  }

  summary(now = null, { observeSince = null } = {}) {
    const tNow = now != null ? now : Date.now() / 1000;
    const windows = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };

    const downtimeInWindow = (seconds, otype = null) => {
      const start = tNow - seconds;
      const outages = this.listOutages({
        fromTs: start,
        toTs: tNow,
        outageType: otype,
        limit: 10000,
      });
      let totalMs = 0;
      for (const o of outages) {
        const oStart = Math.max(o.started_at, start);
        let oEnd = o.ended_at != null ? o.ended_at : tNow;
        oEnd = Math.min(oEnd, tNow);
        if (oEnd > oStart) totalMs += Math.floor((oEnd - oStart) * 1000);
      }
      const windowMs = seconds * 1000;
      const pct = windowMs ? (totalMs / windowMs) * 100.0 : 0.0;
      return {
        downtime_ms: totalMs,
        downtime_pct: Math.round(pct * 1000) / 1000,
        count: outages.length,
      };
    };

    const lastClosed = this._get(
      `SELECT ended_at FROM outages WHERE ended_at IS NOT NULL
       ORDER BY ended_at DESC LIMIT 1`
    );
    const openAny = this._get(
      `SELECT started_at FROM outages WHERE ended_at IS NULL
       ORDER BY started_at ASC LIMIT 1`
    );
    const firstProbe = this._get("SELECT MIN(timestamp) AS t FROM probes");

    // Cap "current uptime streak" to this observation window so history from
    // prior sessions cannot inflate the dashboard beyond how long we've been watching.
    const observeStart =
      observeSince != null
        ? observeSince
        : firstProbe && firstProbe.t != null
          ? firstProbe.t
          : null;

    let uptimeStreakS = 0.0;
    let inOutage = false;
    if (openAny) {
      uptimeStreakS = 0.0;
      inOutage = true;
    } else if (lastClosed && lastClosed.ended_at != null) {
      const baseline =
        observeStart != null
          ? Math.max(lastClosed.ended_at, observeStart)
          : lastClosed.ended_at;
      uptimeStreakS = Math.max(0, tNow - baseline);
      inOutage = false;
    } else if (observeStart != null) {
      uptimeStreakS = Math.max(0, tNow - observeStart);
      inOutage = false;
    }

    const monthStart = tNow - 30 * 86400;
    const recent = this.listOutages({
      fromTs: monthStart,
      toTs: tNow,
      limit: 10000,
    });
    const byHour = Array(24).fill(0);
    const byDow = Array(7).fill(0);
    for (const o of recent) {
      const d = new Date(o.started_at * 1000);
      byHour[d.getHours()] += 1;
      const js = d.getDay();
      byDow[js === 0 ? 6 : js - 1] += 1;
    }

    const longest = this.listOutages({
      fromTs: monthStart,
      toTs: tNow,
      limit: 10,
      orderBy: "duration",
      orderDir: "DESC",
    });
    for (const o of longest) {
      if (o.duration_ms == null) {
        o.duration_ms = Math.floor((tNow - o.started_at) * 1000);
      }
    }

    const sparkStart = tNow - 86400;
    const spark = Array(24).fill(0);
    const dayOutages = this.listOutages({
      fromTs: sparkStart,
      toTs: tNow,
      limit: 10000,
    });
    for (const o of dayOutages) {
      const oStart = Math.max(o.started_at, sparkStart);
      const oEnd = Math.min(o.ended_at != null ? o.ended_at : tNow, tNow);
      let t = oStart;
      while (t < oEnd) {
        let hourIdx = Math.floor((t - sparkStart) / 3600);
        hourIdx = Math.max(0, Math.min(23, hourIdx));
        const bucketEnd = sparkStart + (hourIdx + 1) * 3600;
        const segEnd = Math.min(oEnd, bucketEnd);
        spark[hourIdx] += segEnd - t;
        t = segEnd;
      }
    }

    const recentOutages = this.listOutages({
      fromTs: monthStart,
      toTs: tNow,
      limit: 8,
      orderBy: "started_at",
      orderDir: "DESC",
    });

    // Latency sparkline: downsample recent probe latencies (last 6h)
    const latStart = tNow - 6 * 3600;
    const probes = this.probesSince(latStart).filter(
      (p) => p.latency_ms != null && Number(p.lan_ok) === 1
    );
    const buckets = 48;
    const latencySpark = Array(buckets).fill(null);
    if (probes.length) {
      const span = 6 * 3600;
      const sums = Array(buckets).fill(0);
      const counts = Array(buckets).fill(0);
      for (const p of probes) {
        let idx = Math.floor(((p.timestamp - latStart) / span) * buckets);
        idx = Math.max(0, Math.min(buckets - 1, idx));
        sums[idx] += p.latency_ms;
        counts[idx] += 1;
      }
      for (let i = 0; i < buckets; i++) {
        if (counts[i]) latencySpark[i] = Math.round((sums[i] / counts[i]) * 10) / 10;
      }
    }

    const latestSpeed = this.latestSpeedTest();
    const timelineStart = tNow - 86400;
    const timeline = this.listOutages({
      fromTs: timelineStart,
      toTs: tNow,
      limit: 10000,
      orderBy: "started_at",
      orderDir: "ASC",
    }).map((o) => ({
      id: o.id,
      type: o.type,
      started_at: o.started_at,
      ended_at: o.ended_at,
    }));

    const result = {
      uptime_streak_s: Math.round(uptimeStreakS * 10) / 10,
      in_outage: inOutage,
      windows: {},
      by_hour: byHour,
      by_dow: byDow,
      longest,
      recent_outages: recentOutages,
      sparkline_24h: spark.map((s) => Math.round(s * 10) / 10),
      latency_spark_6h: latencySpark,
      timeline_24h: timeline,
      provider: latestSpeed
        ? {
            isp: latestSpeed.isp || null,
            server_name: latestSpeed.server_name || null,
            server_location: latestSpeed.server_location || null,
            ping_ms: latestSpeed.ping_ms != null ? latestSpeed.ping_ms : null,
            tested_at: latestSpeed.tested_at,
          }
        : null,
    };
    for (const [name, secs] of Object.entries(windows)) {
      result.windows[name] = {
        all: downtimeInWindow(secs),
        lan: downtimeInWindow(secs, "lan"),
        wan: downtimeInWindow(secs, "wan"),
        dns: downtimeInWindow(secs, "dns"),
        http: downtimeInWindow(secs, "http"),
      };
    }
    return result;
  }
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  OUTAGE_TYPES,
  LIST_OUTAGES_LIMIT_MAX,
  normalizeSettingValue,
  normalizeSettingsObject,
  encodeSnapshotJson,
  coerceBoolSetting,
  dataDir,
  dbPath,
  TrackerDb,
  rowsFromExec,
};
