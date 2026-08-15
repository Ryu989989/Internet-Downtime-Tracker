"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const initSqlJs = require("sql.js");
const { isBlockedProbeHost, isBlockedHttpUrl } = require("./netcheck");
const { normalizeWebhookUrl, parseWebhookList } = require("./notify-webhooks");

const APP_DIR_NAME = "InternetDowntimeTracker";
/** Full sql.js export is expensive; debounce aggressively (probes are high-churn). */
const PERSIST_DEBOUNCE_MS = 30_000;

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
  connections_enabled: true,
  connections_resolve_dns: false,
  usage_monitoring: false,
  network_control_enabled: false,
  usage_caps_json: "{}",
  usage_alerts_json: "{}",
  lan_devices_enabled: true,
  lan_new_device_toast: false,
  snmp_enabled: false,
  snmp_community: "public",
  snmp_targets: "",
  sniffer_enabled: false,
  sniffer_always_on: false,
  notify_webhooks_json: "[]",
  notify_quiet_hours_json: "{}",
  influx_enabled: false,
  influx_url: "",
  influx_token: "",
  influx_org: "",
  influx_bucket: "",
  es_enabled: false,
  es_url: "",
  es_api_key: "",
  prom_metrics_enabled: false,
  http_api_enabled: false,
  http_api_token: "",
  lan_active_discovery: false,
  lan_discovery_interval_min: 15,
  router_webhook_url: "",
  router_webhook_template: "",
  router_webhook_auto_new: false,
};

const SETTINGS_BOUNDS = {
  poll_interval_s: { min: 2, max: 3600 },
  debounce_fail_count: { min: 1, max: 20 },
  probe_retention_days: { min: 1, max: 365 },
  port: { min: 1, max: 65535 },
  lan_discovery_interval_min: { min: 5, max: 1440 },
};

const BOOL_SETTINGS = new Set([
  "autostart",
  "toast_alerts",
  "minimize_to_tray",
  "connections_enabled",
  "connections_resolve_dns",
  "usage_monitoring",
  "network_control_enabled",
  "lan_devices_enabled",
  "lan_new_device_toast",
  "snmp_enabled",
  "sniffer_enabled",
  "sniffer_always_on",
  "influx_enabled",
  "es_enabled",
  "prom_metrics_enabled",
  "http_api_enabled",
  "lan_active_discovery",
  "router_webhook_auto_new",
]);

const JSON_SETTINGS = new Set([
  "usage_caps_json",
  "usage_alerts_json",
  "notify_webhooks_json",
  "notify_quiet_hours_json",
]);

const STRING_SETTINGS_MAX = {
  snmp_community: 64,
  snmp_targets: 500,
  notify_webhooks_json: 8000,
  notify_quiet_hours_json: 500,
  influx_url: 500,
  influx_token: 500,
  influx_org: 120,
  influx_bucket: 120,
  es_url: 500,
  es_api_key: 500,
  http_api_token: 128,
  router_webhook_url: 2000,
  router_webhook_template: 4000,
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

const USAGE_JSON_SETTINGS_MAX = 8000;

/** Normalize usage_caps_json / usage_alerts_json to a compact object JSON string. */
function normalizeUsageJsonSetting(value) {
  let obj;
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else if (typeof value === "object") {
    obj = value;
  } else {
    return null;
  }
  if (obj === null || Array.isArray(obj) || typeof obj !== "object") return null;
  const text = JSON.stringify(obj);
  if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
  return text;
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

function normalizeJsonArrayOrObjectSetting(value, preferArray) {
  if (value == null) return null;
  let obj;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return preferArray ? "[]" : "{}";
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else {
    obj = value;
  }
  if (preferArray) {
    if (!Array.isArray(obj)) return null;
  } else if (obj === null || Array.isArray(obj) || typeof obj !== "object") {
    return null;
  }
  const text = JSON.stringify(obj);
  if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
  return text;
}

function normalizeSettingValue(key, value) {
  if (BOOL_SETTINGS.has(key)) {
    return coerceBoolSetting(value);
  }
  if (key === "usage_caps_json" || key === "usage_alerts_json") {
    return normalizeUsageJsonSetting(value);
  }
  if (key === "notify_webhooks_json") {
    const raw = normalizeJsonArrayOrObjectSetting(value, true);
    if (raw == null) return null;
    const cleaned = parseWebhookList(raw);
    return JSON.stringify(cleaned);
  }
  if (key === "notify_quiet_hours_json") {
    return normalizeJsonArrayOrObjectSetting(value, false);
  }
  if (key === "router_webhook_url") {
    if (value == null || value === "") return "";
    const s = String(value).trim();
    if (s.length > STRING_SETTINGS_MAX.router_webhook_url) return null;
    return normalizeWebhookUrl(s) || null;
  }
  if (STRING_SETTINGS_MAX[key] != null && key !== "notify_webhooks_json" && key !== "notify_quiet_hours_json") {
    if (value == null) return "";
    const s = String(value).trim();
    if (s.length > STRING_SETTINGS_MAX[key]) return null;
    return s;
  }
  if (key === "wan_targets" || key === "dns_resolver" || key === "http_url") {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s || s.length > 500) return null;
    if (key === "http_url") {
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        if (isBlockedHttpUrl(s)) return null;
      } catch {
        return null;
      }
      return s;
    }
    if (key === "dns_resolver") {
      if (isBlockedProbeHost(s)) return null;
      return s;
    }
    for (const part of s.split(",")) {
      const bit = part.trim();
      if (!bit) continue;
      const host = bit.split(":")[0].trim();
      if (isBlockedProbeHost(host)) return null;
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
  const normal = path.join(path.dirname(main), "sql-wasm.wasm");
  if (fs.existsSync(normal)) return normal;
  const unpacked = normal.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (fs.existsSync(unpacked)) return unpacked;
  return normal;
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
  constructor(db, filePath, SQL = null) {
    this.db = db;
    this.path = filePath;
    this._SQL = SQL;
    this._persistTimer = null;
    this._persistDirty = false;
    this._persistFailCount = 0;
    this._recovering = false;
    this._initSchema();
    this._persistImmediate();
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
    return new TrackerDb(db, fp, SQL);
  }

  /**
   * Atomic-ish write. Never throws — probe loop / IPC must stay alive if AV
   * briefly locks tracker.db (common source of intermittent "disk I/O error").
   */
  _persistNow() {
    let tmp = null;
    try {
      const data = Buffer.from(this.db.export());
      const dir = path.dirname(this.path);
      fs.mkdirSync(dir, { recursive: true });
      tmp = path.join(dir, `.${path.basename(this.path)}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, data);
      try {
        fs.renameSync(tmp, this.path);
        tmp = null;
      } catch {
        // Windows: rename-over often fails while readers/AV hold the file.
        try {
          fs.copyFileSync(tmp, this.path);
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          tmp = null;
        } catch (err2) {
          throw err2;
        }
      }
      this._persistFailCount = 0;
      return true;
    } catch (err) {
      this._persistFailCount += 1;
      try {
        console.error("db persist failed", err);
      } catch {
        /* ignore */
      }
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
      return false;
    }
  }

  _schedulePersist() {
    this._persistDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        this._flushPersist();
      } catch (err) {
        // Belt-and-suspenders — _persistNow should not throw.
        try {
          console.error("db flush persist failed", err);
        } catch {
          /* ignore */
        }
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  _flushPersist() {
    if (!this._persistDirty) return;
    this._persistDirty = false;
    if (!this._persistNow()) {
      // Retry later; keep dirty so we don't drop probe history.
      this._persistDirty = true;
      if (!this._persistTimer) {
        this._persistTimer = setTimeout(() => {
          this._persistTimer = null;
          try {
            this._flushPersist();
          } catch (err) {
            try {
              console.error("db flush persist retry failed", err);
            } catch {
              /* ignore */
            }
          }
        }, Math.min(60_000, PERSIST_DEBOUNCE_MS));
      }
    }
  }

  _persistImmediate() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persistDirty = false;
    if (!this._persistNow()) {
      this._persistDirty = true;
      this._schedulePersist();
    }
  }

  /** Flush any debounced probe writes (e.g. before quit). */
  flushPersist() {
    this._persistImmediate();
  }

  _persist() {
    this._schedulePersist();
  }

  _isTransientDbError(err) {
    const msg = String((err && err.message) || err || "");
    return /disk I\/O|SQLITE_IOERR|malformed|corrupt|out of memory/i.test(msg);
  }

  /** Reload in-memory DB from the last on-disk snapshot after IOERR. */
  _tryRecoverFromDisk() {
    if (this._recovering || !this._SQL || !this.path) return false;
    if (!fs.existsSync(this.path)) return false;
    this._recovering = true;
    try {
      const buf = fs.readFileSync(this.path);
      const next = new this._SQL.Database(buf);
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = next;
      try {
        console.error("db recovered from disk after transient error");
      } catch {
        /* ignore */
      }
      return true;
    } catch (err) {
      try {
        console.error("db recover failed", err);
      } catch {
        /* ignore */
      }
      return false;
    } finally {
      this._recovering = false;
    }
  }

  _run(sql, params = []) {
    try {
      this.db.run(sql, params);
    } catch (err) {
      if (this._isTransientDbError(err) && this._tryRecoverFromDisk()) {
        this.db.run(sql, params);
        return;
      }
      throw err;
    }
  }

  _all(sql, params = []) {
    const run = () => {
      const stmt = this.db.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        return rows;
      } finally {
        try {
          stmt.free();
        } catch {
          /* ignore */
        }
      }
    };
    try {
      return run();
    } catch (err) {
      if (this._isTransientDbError(err) && this._tryRecoverFromDisk()) {
        return run();
      }
      throw err;
    }
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

      CREATE TABLE IF NOT EXISTS usage_apps (
        app_key TEXT PRIMARY KEY,
        display_name TEXT,
        exe_path TEXT,
        ignored INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS usage_hourly (
        app_key TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(app_key, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_hourly_ts ON usage_hourly(bucket_ts);

      CREATE TABLE IF NOT EXISTS usage_daily (
        app_key TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(app_key, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_daily_ts ON usage_daily(bucket_ts);

      CREATE TABLE IF NOT EXISTS usage_alert_state (
        rule_key TEXT PRIMARY KEY,
        last_fired_at REAL
      );

      CREATE TABLE IF NOT EXISTS lan_devices (
        mac TEXT PRIMARY KEY,
        ip TEXT,
        vendor TEXT,
        alias TEXT,
        notes TEXT,
        hostname TEXT,
        state TEXT,
        iface TEXT,
        first_seen REAL,
        last_seen REAL,
        online INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        gateway INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_lan_devices_ip ON lan_devices(ip);
      CREATE INDEX IF NOT EXISTS idx_lan_devices_last ON lan_devices(last_seen);

      CREATE TABLE IF NOT EXISTS lan_scan_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_ip TEXT NOT NULL,
        started_at REAL NOT NULL,
        finished_at REAL,
        ports_json TEXT,
        cve_json TEXT,
        status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lan_scan_at ON lan_scan_results(started_at);
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

    const lanCols = new Set(
      this._all("PRAGMA table_info(lan_devices)").map((c) => c.name)
    );
    if (!lanCols.has("hostname")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN hostname TEXT");
    }
    if (!lanCols.has("state")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN state TEXT");
    }
    if (!lanCols.has("iface")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN iface TEXT");
    }
  }

  close() {
    try {
      this._persistImmediate();
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
    this._persistImmediate();
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
    this._persistImmediate();
    return Number(row.id);
  }

  updateOutageNotes(outageId, notes) {
    const id = Number(outageId);
    if (!Number.isFinite(id)) return null;
    const text = notes == null ? null : String(notes).slice(0, 2000);
    this._run("UPDATE outages SET notes=? WHERE id=?", [text, id]);
    this._persistImmediate();
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
    this._persistImmediate();
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
    this._persistImmediate();
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
    this._persistImmediate();
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
    this._persistImmediate();
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
    const lim = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 100));
    params.push(lim);
    return this._all(
      `SELECT * FROM speed_tests ${where} ORDER BY tested_at DESC LIMIT ?`,
      params
    );
  }

  upsertUsageApp({ app_key, display_name, exe_path, ignored = undefined }) {
    const key = String(app_key || "").trim();
    if (!key) return null;
    const name = display_name == null ? null : String(display_name).slice(0, 256);
    const exe = exe_path == null ? null : String(exe_path).slice(0, 1024);
    const existing = this._get("SELECT ignored FROM usage_apps WHERE app_key=?", [key]);
    const ign =
      ignored !== undefined ? (ignored ? 1 : 0) : existing ? existing.ignored : 0;
    this._run(
      `INSERT INTO usage_apps (app_key, display_name, exe_path, ignored)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_key) DO UPDATE SET
         display_name=excluded.display_name,
         exe_path=excluded.exe_path,
         ignored=excluded.ignored`,
      [key, name, exe, ign]
    );
    this._persist();
    return this._get("SELECT * FROM usage_apps WHERE app_key=?", [key]);
  }

  setUsageIgnored(app_key, ignored) {
    const key = String(app_key || "").trim();
    if (!key) return null;
    this._run("UPDATE usage_apps SET ignored=? WHERE app_key=?", [
      ignored ? 1 : 0,
      key,
    ]);
    this._persist();
    return this._get("SELECT * FROM usage_apps WHERE app_key=?", [key]);
  }

  listUsageApps({ includeIgnored = false } = {}) {
    if (includeIgnored) {
      return this._all(
        "SELECT * FROM usage_apps ORDER BY display_name, app_key"
      );
    }
    return this._all(
      "SELECT * FROM usage_apps WHERE ignored=0 ORDER BY display_name, app_key"
    );
  }

  addUsageBytes({ app_key, bytes_in = 0, bytes_out = 0, atMs = null } = {}) {
    const key = String(app_key || "").trim();
    if (!key) return;
    const bi = Math.max(0, Math.trunc(Number(bytes_in)) || 0);
    const bo = Math.max(0, Math.trunc(Number(bytes_out)) || 0);
    if (!bi && !bo) return;
    const ms = atMs != null ? Number(atMs) : Date.now();
    if (!Number.isFinite(ms)) return;
    const sec = Math.floor(ms / 1000);
    const hourTs = Math.floor(sec / 3600) * 3600;
    const dayTs = Math.floor(sec / 86400) * 86400;
    this._run(
      `INSERT INTO usage_hourly (app_key, bucket_ts, bytes_in, bytes_out)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_key, bucket_ts) DO UPDATE SET
         bytes_in=bytes_in+excluded.bytes_in,
         bytes_out=bytes_out+excluded.bytes_out`,
      [key, hourTs, bi, bo]
    );
    this._run(
      `INSERT INTO usage_daily (app_key, bucket_ts, bytes_in, bytes_out)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_key, bucket_ts) DO UPDATE SET
         bytes_in=bytes_in+excluded.bytes_in,
         bytes_out=bytes_out+excluded.bytes_out`,
      [key, dayTs, bi, bo]
    );
    this._persist();
  }

  listUsageHourly({ fromTs = null, toTs = null, app_key = null } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("bucket_ts >= ?");
      params.push(Math.trunc(Number(fromTs)));
    }
    if (toTs != null) {
      clauses.push("bucket_ts <= ?");
      params.push(Math.trunc(Number(toTs)));
    }
    if (app_key != null && String(app_key).trim()) {
      clauses.push("app_key = ?");
      params.push(String(app_key).trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT app_key, bucket_ts, bytes_in, bytes_out
       FROM usage_hourly ${where} ORDER BY bucket_ts, app_key`,
      params
    );
  }

  listUsageDaily({ fromTs = null, toTs = null, app_key = null } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("bucket_ts >= ?");
      params.push(Math.trunc(Number(fromTs)));
    }
    if (toTs != null) {
      clauses.push("bucket_ts <= ?");
      params.push(Math.trunc(Number(toTs)));
    }
    if (app_key != null && String(app_key).trim()) {
      clauses.push("app_key = ?");
      params.push(String(app_key).trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT app_key, bucket_ts, bytes_in, bytes_out
       FROM usage_daily ${where} ORDER BY bucket_ts, app_key`,
      params
    );
  }

  usageTotals({ fromTs = null, toTs = null, granularity = "hourly" } = {}) {
    const table = granularity === "daily" ? "usage_daily" : "usage_hourly";
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("bucket_ts >= ?");
      params.push(Math.trunc(Number(fromTs)));
    }
    if (toTs != null) {
      clauses.push("bucket_ts <= ?");
      params.push(Math.trunc(Number(toTs)));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT app_key,
              SUM(bytes_in) AS bytes_in,
              SUM(bytes_out) AS bytes_out,
              SUM(bytes_in + bytes_out) AS bytes_total
       FROM ${table} ${where}
       GROUP BY app_key
       ORDER BY bytes_total DESC`,
      params
    );
  }

  pruneUsage({ hourlyDays = 14, dailyDays = 90 } = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    const hDays = Math.max(1, Math.trunc(Number(hourlyDays)) || 14);
    const dDays = Math.max(1, Math.trunc(Number(dailyDays)) || 90);
    const hourCutoff = nowSec - hDays * 86400;
    const dayCutoff = nowSec - dDays * 86400;
    this._run("DELETE FROM usage_hourly WHERE bucket_ts < ?", [hourCutoff]);
    this._run("DELETE FROM usage_daily WHERE bucket_ts < ?", [dayCutoff]);
    this._persistImmediate();
  }

  clearUsageHistory() {
    this._run("DELETE FROM usage_hourly");
    this._run("DELETE FROM usage_daily");
    this._run("DELETE FROM usage_apps");
    this._run("DELETE FROM usage_alert_state");
    this._persistImmediate();
  }

  getAlertLastFired(rule_key) {
    const key = String(rule_key || "").trim();
    if (!key) return null;
    const row = this._get(
      "SELECT last_fired_at FROM usage_alert_state WHERE rule_key=?",
      [key]
    );
    return row && row.last_fired_at != null ? row.last_fired_at : null;
  }

  setAlertLastFired(rule_key, atSec) {
    const key = String(rule_key || "").trim();
    if (!key) return;
    const ts = Number(atSec);
    if (!Number.isFinite(ts)) return;
    this._run(
      `INSERT INTO usage_alert_state (rule_key, last_fired_at) VALUES (?, ?)
       ON CONFLICT(rule_key) DO UPDATE SET last_fired_at=excluded.last_fired_at`,
      [key, ts]
    );
    this._persist();
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

    // Cap streak to the observation clock (MIN first probe / first outage).
    // Session `started_at` is not history — callers must not pass process start.
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

  upsertLanDevice(row) {
    const mac = String(row.mac || "").toUpperCase();
    if (!mac) return null;
    this._run(
      `INSERT INTO lan_devices (mac, ip, vendor, alias, notes, hostname, state, iface, first_seen, last_seen, online, source, gateway)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mac) DO UPDATE SET
         ip=excluded.ip,
         vendor=COALESCE(excluded.vendor, lan_devices.vendor),
         alias=COALESCE(excluded.alias, lan_devices.alias),
         notes=COALESCE(excluded.notes, lan_devices.notes),
         hostname=COALESCE(excluded.hostname, lan_devices.hostname),
         state=COALESCE(excluded.state, lan_devices.state),
         iface=COALESCE(excluded.iface, lan_devices.iface),
         last_seen=excluded.last_seen,
         online=excluded.online,
         source=excluded.source,
         gateway=excluded.gateway`,
      [
        mac,
        row.ip != null ? String(row.ip).slice(0, 64) : null,
        row.vendor != null ? String(row.vendor).slice(0, 120) : null,
        row.alias != null ? String(row.alias).slice(0, 120) : null,
        row.notes != null ? String(row.notes).slice(0, 500) : null,
        row.hostname != null ? String(row.hostname).slice(0, 120) : null,
        row.state != null ? String(row.state).slice(0, 32) : null,
        row.iface != null ? String(row.iface).slice(0, 64) : null,
        row.first_seen != null ? Number(row.first_seen) : Date.now() / 1000,
        row.last_seen != null ? Number(row.last_seen) : Date.now() / 1000,
        row.online ? 1 : 0,
        row.source != null ? String(row.source).slice(0, 32) : "neighbor",
        row.gateway ? 1 : 0,
      ]
    );
    return this.getLanDevice(mac);
  }

  getLanDevice(mac) {
    return this._get("SELECT * FROM lan_devices WHERE mac = ?", [String(mac || "").toUpperCase()]);
  }

  listLanDevices() {
    return this._all(
      "SELECT * FROM lan_devices ORDER BY gateway DESC, online DESC, last_seen DESC LIMIT 500"
    );
  }

  updateLanDeviceMeta(mac, { alias, notes } = {}) {
    const row = this.getLanDevice(mac);
    if (!row) return null;
    const nextAlias = alias !== undefined ? String(alias || "").slice(0, 120) : row.alias;
    const nextNotes = notes !== undefined ? String(notes || "").slice(0, 500) : row.notes;
    this._run("UPDATE lan_devices SET alias = ?, notes = ? WHERE mac = ?", [
      nextAlias,
      nextNotes,
      String(mac).toUpperCase(),
    ]);
    return this.getLanDevice(mac);
  }

  markLanDevicesOffline(beforeTs) {
    this._run("UPDATE lan_devices SET online = 0 WHERE last_seen < ? AND online = 1", [
      Number(beforeTs) || 0,
    ]);
  }

  insertLanScanResult(row) {
    this._run(
      `INSERT INTO lan_scan_results (target_ip, started_at, finished_at, ports_json, cve_json, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(row.target_ip || "").slice(0, 64),
        Number(row.started_at) || Date.now() / 1000,
        row.finished_at != null ? Number(row.finished_at) : null,
        row.ports_json != null ? String(row.ports_json).slice(0, 20000) : null,
        row.cve_json != null ? String(row.cve_json).slice(0, 20000) : null,
        row.status != null ? String(row.status).slice(0, 32) : "done",
      ]
    );
    return this._get("SELECT * FROM lan_scan_results ORDER BY id DESC LIMIT 1");
  }

  listLanScanResults({ limit = 20 } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    return this._all(
      `SELECT * FROM lan_scan_results ORDER BY started_at DESC LIMIT ${lim}`
    );
  }

  getLatestScanForIp(ip) {
    const target = String(ip || "").trim().slice(0, 64);
    if (!target) return null;
    return this._get(
      "SELECT * FROM lan_scan_results WHERE target_ip = ? ORDER BY started_at DESC LIMIT 1",
      [target]
    );
  }
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  OUTAGE_TYPES,
  LIST_OUTAGES_LIMIT_MAX,
  BOOL_SETTINGS,
  normalizeSettingValue,
  normalizeSettingsObject,
  encodeSnapshotJson,
  coerceBoolSetting,
  dataDir,
  dbPath,
  TrackerDb,
  rowsFromExec,
};
