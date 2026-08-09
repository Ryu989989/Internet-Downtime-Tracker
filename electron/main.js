"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification, screen } = require("electron");

const { TrackerDb } = require("./db");
const { Monitor } = require("./monitor");
const autostart = require("./autostart");
const { trayIcon, stateColor, resolveAppIconPath } = require("./icons");
const systemLogs = require("./system-logs");
const speedtest = require("./speedtest");
const { isHttpsUrl } = require("./url-policy");
const { buildEvidenceCsv, buildHtmlReport, fmtDuration } = require("./export");
const connections = require("./connections");
const usageBridge = require("./usage-bridge");
const usageControl = require("./usage-control");
const lanBridge = require("./lan-bridge");

/** Exports always land under downloads/temp — ignore renderer-supplied paths. */
function resolveExportDest(kind) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === "report") {
    return path.join(os.tmpdir(), `idt-report-${Date.now()}.html`);
  }
  return path.join(
    app.getPath("downloads") || os.tmpdir(),
    `idt-outages-${stamp}.csv`
  );
}

app.setAppUserModelId("com.local.internetdowntimetracker");

let mainWindow = null;
let tray = null;
let db = null;
let monitor = null;
let iconColor = "gray";
let quitting = false;
/** @type {Map<string, { in: number, out: number }>} */
const lastUsageSampleBytes = new Map();
let usageRollupTimer = null;
let usagePruneTick = 0;

function isBenignPipeError(err) {
  if (!err) return false;
  const code = err.code || err.errno;
  return (
    code === "EPIPE" ||
    code === "EIO" ||
    code === "ERR_STREAM_DESTROYED" ||
    (typeof err.message === "string" && /broken pipe/i.test(err.message))
  );
}

function patchConsoleForBrokenPipes() {
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[method];
    if (typeof orig !== "function") continue;
    console[method] = (...args) => {
      try {
        return orig.apply(console, args);
      } catch (err) {
        if (!isBenignPipeError(err)) throw err;
      }
    };
  }
}

patchConsoleForBrokenPipes();

process.on("uncaughtException", (err) => {
  if (isBenignPipeError(err)) return;
  try {
    console.error("uncaughtException", err);
  } catch {
    /* ignore */
  }
});

process.on("unhandledRejection", (reason) => {
  if (isBenignPipeError(reason)) return;
  try {
    console.error("unhandledRejection", reason);
  } catch {
    /* ignore */
  }
});

function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (event.sender.isDestroyed()) return null;
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      if (event.sender !== mainWindow.webContents) return null;
      return await handler(event, ...args);
    } catch (err) {
      if (event.sender.isDestroyed() || isBenignPipeError(err)) return null;
      try {
        console.error(`ipc ${channel} failed`, err);
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error("Internet Downtime Tracker is already running.");
  app.quit();
} else {
  app.on("second-instance", () => {
    showDashboard();
  });
  app.whenReady().then(boot).catch((err) => {
    console.error("boot failed", err);
    app.quit();
  });
}

function webIndex() {
  return path.join(__dirname, "..", "web", "index.html");
}

function minimizeToTrayEnabled() {
  if (!db) return true;
  try {
    return db.getSettings().minimize_to_tray !== false;
  } catch {
    return true;
  }
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function defaultWindowBounds() {
  const { width: dw, height: dh } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(1680, Math.max(960, Math.round(dw * 0.9))),
    height: Math.min(1040, Math.max(640, Math.round(dh * 0.9))),
    minWidth: 800,
    minHeight: 560,
  };
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  const bounds = defaultWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    show: false,
    backgroundColor: "#0f1419",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: "Internet Downtime Tracker",
  });

  mainWindow.loadFile(webIndex());
  mainWindow.webContents.on("will-navigate", (event) => {
    // Dashboard is loadFile-only; block in-page navigations / injected redirects.
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpsUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("close", (e) => {
    if (quitting) return;
    if (minimizeToTrayEnabled()) {
      e.preventDefault();
      hideToTray();
      return;
    }
    // Setting off: allow real close → app exits (see window-all-closed).
    quitting = true;
  });

  mainWindow.on("minimize", (e) => {
    if (quitting || !minimizeToTrayEnabled()) return;
    e.preventDefault();
    hideToTray();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Renderer window.resize can miss some Electron maximize/restore passes.
  let resizeNotifyTimer = null;
  const notifyLayout = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("ui:layout");
  };
  const scheduleLayoutNotify = () => {
    if (resizeNotifyTimer) clearTimeout(resizeNotifyTimer);
    resizeNotifyTimer = setTimeout(notifyLayout, 50);
  };
  mainWindow.on("resize", scheduleLayoutNotify);
  mainWindow.on("maximize", scheduleLayoutNotify);
  mainWindow.on("unmaximize", scheduleLayoutNotify);
  mainWindow.on("enter-full-screen", scheduleLayoutNotify);
  mainWindow.on("leave-full-screen", scheduleLayoutNotify);
}

function showDashboard() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  const paused = monitor ? monitor.state.paused : false;
  const autoOn = autostart.isEnabled();
  return Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => showDashboard() },
    {
      label: paused ? "Resume" : "Pause",
      click: () => {
        if (!monitor) return;
        monitor.togglePause();
        tray.setContextMenu(buildTrayMenu());
      },
    },
    {
      label: autoOn ? "Start with Windows: On" : "Start with Windows: Off",
      type: "checkbox",
      checked: autoOn,
      click: (item) => {
        const want = item.checked;
        try {
          autostart.setEnabled(want);
          if (db) db.updateSettings({ autostart: want });
        } catch (err) {
          console.error(err);
        }
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        if (monitor) monitor.stop();
        if (db) db.close();
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon("gray"));
  tray.setToolTip("Internet Downtime Tracker");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => showDashboard());
}

function pushStatusUpdate() {
  if (!monitor || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send("status:update", monitor.snapshot());
  } catch (err) {
    if (!isBenignPipeError(err)) {
      try {
        console.error("status:update push failed", err);
      } catch {
        /* ignore */
      }
    }
  }
}

function onMonitorState(state) {
  const color = stateColor(state);
  if (tray && color !== iconColor) {
    iconColor = color;
    try {
      tray.setImage(trayIcon(color));
    } catch (err) {
      console.error("icon update failed", err);
    }
    try {
      tray.setContextMenu(buildTrayMenu());
    } catch {
      /* ignore */
    }
  }
  pushStatusUpdate();
}

function maybeNotifyOutage(event) {
  if (!event || !db || !monitor) return;
  if (monitor.state.probe_suppressed || monitor._suppressProbes) return;
  const settings = db.getSettings();
  if (settings.toast_alerts && Notification.isSupported()) {
    const type = String(event.type || "outage").toUpperCase();
    if (event.action === "open") {
      new Notification({
        title: `${type} outage started`,
        body: "Connectivity check failed after debounce.",
      }).show();
    } else if (event.action === "close") {
      const dur =
        event.duration_ms != null ? fmtDuration(event.duration_ms) : "unknown duration";
      new Notification({
        title: `${type} outage ended`,
        body: `Recovered · ${dur}`,
      }).show();
    }
  }
  lanBridge
    .onOutageEvent(event.action === "open" ? "outage_open" : "outage_close", event)
    .catch(() => {});
}

function userDataPath() {
  return app.getPath("userData");
}

function utcMonthStartSec(nowSec) {
  const d = new Date(nowSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

function processLiveUsageApps(apps, suppress) {
  if (!db || !Array.isArray(apps)) return;
  const ignoredKeys = new Set(
    db
      .listUsageApps({ includeIgnored: true })
      .filter((a) => a.ignored)
      .map((a) => String(a.app_key))
  );
  for (const row of apps) {
    const appKey = row && row.app_key != null ? String(row.app_key).trim() : "";
    if (!appKey) continue;
    const existing = db._get(
      "SELECT display_name, exe_path, ignored FROM usage_apps WHERE app_key=?",
      [appKey]
    );
    const name = row.name != null ? String(row.name).slice(0, 256) : null;
    const exe = row.exe != null ? String(row.exe).slice(0, 1024) : null;
    if (
      !existing ||
      existing.display_name !== name ||
      existing.exe_path !== exe
    ) {
      db.upsertUsageApp({
        app_key: appKey,
        display_name: name,
        exe_path: exe,
      });
    }
    if (suppress || ignoredKeys.has(appKey) || (existing && existing.ignored)) continue;
    const curIn = Math.max(0, Math.trunc(Number(row.bytes_in) || 0));
    const curOut = Math.max(0, Math.trunc(Number(row.bytes_out) || 0));
    const prev = lastUsageSampleBytes.get(appKey) || { in: 0, out: 0 };
    const dIn = curIn >= prev.in ? curIn - prev.in : 0;
    const dOut = curOut >= prev.out ? curOut - prev.out : 0;
    lastUsageSampleBytes.set(appKey, { in: curIn, out: curOut });
    if (dIn || dOut) {
      db.addUsageBytes({ app_key: appKey, bytes_in: dIn, bytes_out: dOut });
    }
  }
  usagePruneTick += 1;
  if (usagePruneTick % 120 === 0) {
    try {
      db.pruneUsage();
    } catch (err) {
      console.error("usage prune failed", err);
    }
  }
}

function evaluateUsageAlertsAndCaps() {
  if (!db) return;
  const settings = db.getSettings();
  const nowSec = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(nowSec / 86400) * 86400;
  const monthStart = utcMonthStartSec(nowSec);
  const dailyRows = db.usageTotals({ fromTs: dayStart, toTs: nowSec, granularity: "daily" });
  const monthlyRows = db.usageTotals({ fromTs: monthStart, toTs: nowSec, granularity: "daily" });
  const totalsByApp = {};
  const dailyByApp = {};
  const monthlyByApp = {};
  let dailyGlobal = 0;
  let monthlyGlobal = 0;
  for (const row of dailyRows) {
    totalsByApp[row.app_key] = {
      bytes_in: Number(row.bytes_in) || 0,
      bytes_out: Number(row.bytes_out) || 0,
    };
    const total = Number(row.bytes_total) || 0;
    dailyByApp[row.app_key] = total;
    dailyGlobal += total;
  }
  for (const row of monthlyRows) {
    const total = Number(row.bytes_total) || 0;
    monthlyByApp[row.app_key] = total;
    monthlyGlobal += total;
  }
  const alertFires = usageControl.evaluateAlerts({
    alertsJson: settings.usage_alerts_json,
    totalsByApp,
    globalTotal: dailyGlobal,
    nowSec,
    getLastFired: (key) => db.getAlertLastFired(key),
  });
  for (const fire of alertFires) {
    db.setAlertLastFired(fire.rule_key, nowSec);
    if (settings.toast_alerts) {
      new Notification({
        title: "Usage alert",
        body: fire.message || "Usage threshold reached",
      }).show();
    }
  }
  const capHits = usageControl.evaluateCaps({
    capsJson: settings.usage_caps_json,
    dailyByApp,
    monthlyByApp,
    dailyGlobal,
    monthlyGlobal,
  });
  for (const hit of capHits) {
    const ruleKey = `cap:${hit.scope}:${hit.period}:${hit.app_key || "global"}`;
    const last = Number(db.getAlertLastFired(ruleKey) || 0);
    if (last && nowSec - last < usageControl.DEFAULT_COOLDOWN_S) continue;
    db.setAlertLastFired(ruleKey, nowSec);
    const capBody =
      hit.scope === "global"
        ? `Global ${hit.period} cap reached (${hit.used}/${hit.cap} bytes)`
        : `${hit.app_key} ${hit.period} cap reached (${hit.used}/${hit.cap} bytes)`;
    if (settings.toast_alerts) {
      new Notification({ title: "Usage cap", body: capBody }).show();
    }
    // Auto-block only with master toggle + explicit auto_block in caps JSON; once per cooldown.
    if (settings.network_control_enabled && hit.auto_block && hit.exe_path) {
      const exe = usageControl.sanitizeExePath(hit.exe_path);
      if (exe && usageBridge.status().connected) {
        usageBridge.blockExe(exe).catch((err) => {
          console.error("auto-block failed", err);
        });
      }
    }
  }
}

async function rollupUsageFromLive() {
  if (!usageBridge.status().connected) return;
  const live = await usageBridge.getLive();
  if (!live.ok) return;
  const suppress = !!(live.suppress || usageBridge.status().suppress);
  processLiveUsageApps(live.apps, suppress);
  evaluateUsageAlertsAndCaps();
}

function startUsageRollupInterval() {
  if (usageRollupTimer || !usageBridge.status().connected) return;
  usageRollupTimer = setInterval(() => {
    rollupUsageFromLive().catch((err) => {
      console.error("usage rollup failed", err);
    });
  }, 5000);
}

function stopUsageRollupInterval() {
  if (!usageRollupTimer) return;
  clearInterval(usageRollupTimer);
  usageRollupTimer = null;
}

function buildUsageCsv(rows, granularity) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["app_key,bucket_ts,bytes_in,bytes_out,granularity"];
  for (const row of rows || []) {
    lines.push(
      [
        esc(row.app_key),
        esc(row.bucket_ts),
        esc(row.bytes_in),
        esc(row.bytes_out),
        esc(granularity),
      ].join(",")
    );
  }
  return lines.join("\n");
}

function registerIpc() {
  safeHandle("api:status", () => monitor.snapshot());
  safeHandle("api:summary", () =>
    db.summary(null, { observeSince: monitor.state.started_at })
  );
  safeHandle("api:settings", () => db.getSettings());
  safeHandle("api:settings:update", async (_e, body) => {
    const prev = db.getSettings();
    const updated = db.updateSettings(body || {});
    if (Object.prototype.hasOwnProperty.call(body || {}, "probe_retention_days")) {
      try {
        db.pruneProbes();
      } catch (err) {
        console.error("probe prune failed", err);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, "autostart")) {
      try {
        const on = autostart.setEnabled(!!updated.autostart);
        if (on !== !!updated.autostart) {
          db.updateSettings({ autostart: on });
          updated.autostart = on;
        }
        try {
          updated.autostart_path = autostart.resolvedExePath();
        } catch {
          updated.autostart_path = null;
        }
      } catch (err) {
        console.error("autostart update failed", err);
        updated.autostart = false;
        db.updateSettings({ autostart: false });
      }
      if (tray) tray.setContextMenu(buildTrayMenu());
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, "usage_monitoring")) {
      if (updated.usage_monitoring) {
        // Persist only after helper connects; otherwise revert flag (honest privilege UX).
        usageBridge
          .startElevated(userDataPath())
          .then((st) => {
            if (st && st.connected) {
              startUsageRollupInterval();
              return;
            }
            db.updateSettings({ usage_monitoring: false });
          })
          .catch((err) => {
            console.error("usage enable from settings failed", err);
            try {
              db.updateSettings({ usage_monitoring: false });
            } catch {
              /* ignore */
            }
          });
      } else {
        stopUsageRollupInterval();
        usageBridge.stop().catch(() => {});
      }
    }
    try {
      await lanBridge.applyIntegrationSettings(prev, updated);
    } catch (err) {
      console.error("lan integration settings failed", err);
    }
    return updated;
  });
  safeHandle("api:monitor:pause", (_e, paused) => {
    if (!monitor) return { paused: false };
    if (paused) monitor.pause();
    else monitor.resume();
    if (tray) tray.setContextMenu(buildTrayMenu());
    return { paused: !!monitor.state.paused };
  });
  safeHandle("api:outages", (_e, params = {}) => {
    const rows = db.listOutages({
      fromTs: params.from != null ? Number(params.from) : null,
      toTs: params.to != null ? Number(params.to) : null,
      outageType: params.type || null,
      minMs: params.min_ms != null ? Number(params.min_ms) : null,
      limit: params.limit != null ? Number(params.limit) : 500,
      orderBy: params.sort || "started_at",
      orderDir: params.dir || "DESC",
    });
    return { outages: rows, count: rows.length };
  });
  safeHandle("api:outages:notes", (_e, body = {}) => {
    const row = db.updateOutageNotes(body.id, body.notes);
    return { outage: row };
  });
  safeHandle("api:export:outages", async (_e, params = {}) => {
    const now = Date.now() / 1000;
    const fromTs = params.from != null ? Number(params.from) : now - 30 * 86400;
    const toTs = params.to != null ? Number(params.to) : now;
    const outages = db.listOutages({
      fromTs,
      toTs,
      outageType: params.type || null,
      limit: 5000,
      orderBy: "started_at",
      orderDir: "DESC",
    });
    const includeSpeed = params.include_speed !== false;
    const speedTests = includeSpeed
      ? db.listSpeedTests({ fromTs, toTs, limit: 500 })
      : [];
    const csv = buildEvidenceCsv({ outages, speedTests, now });
    const dest = resolveExportDest("csv");
    fs.writeFileSync(dest, csv, "utf8");
    return { path: dest, count: outages.length };
  });
  safeHandle("api:export:report", async (_e, params = {}) => {
    const now = Date.now() / 1000;
    const fromTs = params.from != null ? Number(params.from) : now - 30 * 86400;
    const toTs = params.to != null ? Number(params.to) : now;
    const summary = db.summary(now, {
      observeSince: monitor ? monitor.state.started_at : null,
    });
    const outages = db.listOutages({
      fromTs,
      toTs,
      limit: 500,
      orderBy: "started_at",
      orderDir: "DESC",
    });
    const html = buildHtmlReport({ summary, outages, now });
    const dest = resolveExportDest("report");
    fs.writeFileSync(dest, html, "utf8");
    await shell.openPath(dest);
    return { path: dest };
  });
  safeHandle("api:system-logs:get", (_e, params = {}) =>
    systemLogs.getOrScan({ ...(params || {}), refresh: false })
  );
  safeHandle("api:system-logs:scan", (_e, params = {}) =>
    systemLogs.getOrScan({ ...(params || {}), refresh: true })
  );

  const userData = () => app.getPath("userData");
  safeHandle("api:speedtest:status", () => speedtest.getStatus(userData()));
  safeHandle("api:speedtest:history", (_e, params = {}) => {
    try {
      const rows = db.listSpeedTests({
        fromTs: params.from != null ? Number(params.from) : null,
        toTs: params.to != null ? Number(params.to) : null,
        limit: params.limit != null ? Number(params.limit) : 100,
      });
      return { tests: rows, count: rows.length, latest: db.latestSpeedTest() };
    } catch (err) {
      console.error("speedtest history failed", err);
      return {
        tests: [],
        count: 0,
        latest: null,
        error: String((err && err.message) || err || "database unavailable"),
      };
    }
  });
  safeHandle("api:speedtest:run", async () => {
    if (monitor) monitor.setProbeSuppress(true);
    await usageBridge.setSuppress(true);
    try {
      const result = await speedtest.runSpeedTest(userData());
      const saved = db.insertSpeedTest({
        tested_at: result.tested_at,
        download_mbps: result.download_mbps,
        upload_mbps: result.upload_mbps,
        ping_ms: result.ping_ms,
        jitter_ms: result.jitter_ms,
        packet_loss: result.packet_loss,
        server_name: result.server_name,
        server_id: result.server_id,
        server_location: result.server_location,
        isp: result.isp,
        result_url: result.result_url,
        raw_json: result.raw_json,
      });
      return { test: saved, ok: true };
    } catch (err) {
      if (err && err.code === "CANCELLED") {
        return { ok: false, cancelled: true, error: err.message };
      }
      throw err;
    } finally {
      // Cool-down ignores failure streaks after saturated-link blips.
      if (monitor) monitor.setProbeSuppress(false, { cooldownMs: 8000 });
      await usageBridge.setSuppress(false);
    }
  });
  safeHandle("api:speedtest:cancel", () => {
    const ok = speedtest.cancelRun();
    if (monitor) monitor.setProbeSuppress(false, { cooldownMs: 8000 });
    usageBridge.setSuppress(false).catch(() => {});
    return { ...ok, status: ok.cancelled ? "cancelled" : "idle" };
  });
  safeHandle("api:speedtest:install", async () => {
    const installed = await speedtest.installOfficialCli(userData());
    return { ...installed, ...(await speedtest.getStatus(userData())) };
  });

  safeHandle("api:connections:snapshot", async (_e, params = {}) => {
    const settings = db.getSettings();
    if (settings.connections_enabled === false) {
      return {
        ok: false,
        connections: [],
        adapters: [],
        warning: "Connections disabled in Settings",
      };
    }
    return connections.snapshot({
      establishedOnly: !!(params && params.establishedOnly),
    });
  });

  safeHandle("api:usage:status", () => {
    const settings = db.getSettings();
    return {
      ...usageBridge.status(),
      usage_monitoring: !!settings.usage_monitoring,
      network_control_enabled: !!settings.network_control_enabled,
      connections_enabled: settings.connections_enabled !== false,
    };
  });

  safeHandle("api:usage:enable", async () => {
    const result = await usageBridge.startElevated(userDataPath());
    if (result && result.connected) {
      db.updateSettings({ usage_monitoring: true });
      startUsageRollupInterval();
      return { ...result, usage_monitoring: true };
    }
    db.updateSettings({ usage_monitoring: false });
    return { ...result, usage_monitoring: false };
  });

  safeHandle("api:usage:live", async () => {
    const live = await usageBridge.getLive();
    if (live.ok) {
      processLiveUsageApps(
        live.apps,
        !!(live.suppress || usageBridge.status().suppress)
      );
    }
    return live;
  });

  safeHandle("api:usage:history", (_e, params = {}) => {
    const fromTs = params.from != null ? Number(params.from) : null;
    const toTs = params.to != null ? Number(params.to) : null;
    const granularity = params.granularity === "daily" ? "daily" : "hourly";
    const series =
      granularity === "daily"
        ? db.listUsageDaily({
            fromTs,
            toTs,
            app_key: params.app_key || null,
          })
        : db.listUsageHourly({
            fromTs,
            toTs,
            app_key: params.app_key || null,
          });
    return {
      granularity,
      series,
      totals: db.usageTotals({ fromTs, toTs, granularity }),
      apps: db.listUsageApps({ includeIgnored: true }),
    };
  });

  safeHandle("api:usage:clear", () => {
    db.clearUsageHistory();
    lastUsageSampleBytes.clear();
    return { ok: true };
  });

  safeHandle("api:usage:ignore", (_e, body = {}) => {
    const row = db.setUsageIgnored(body.app_key, !!body.ignored);
    return { app: row };
  });

  safeHandle("api:usage:export", async (_e, params = {}) => {
    const now = Date.now() / 1000;
    const fromTs = params.from != null ? Number(params.from) : now - 30 * 86400;
    const toTs = params.to != null ? Number(params.to) : now;
    const granularity = params.granularity === "hourly" ? "hourly" : "daily";
    const rows =
      granularity === "hourly"
        ? db.listUsageHourly({ fromTs, toTs })
        : db.listUsageDaily({ fromTs, toTs });
    const csv = buildUsageCsv(rows, granularity);
    const dest = path.join(
      app.getPath("downloads") || os.tmpdir(),
      `idt-usage-${new Date().toISOString().slice(0, 10)}.csv`
    );
    fs.writeFileSync(dest, csv, "utf8");
    return { path: dest, count: rows.length, granularity };
  });

  safeHandle("api:usage:block", async (_e, body = {}) => {
    const settings = db.getSettings();
    usageControl.assertControlAllowed(settings);
    const exe = usageControl.sanitizeExePath(body.exe_path || body.exe);
    if (!exe) throw new Error("Invalid executable path");
    return usageBridge.blockExe(exe);
  });

  safeHandle("api:usage:unblock", async (_e, body = {}) => {
    const settings = db.getSettings();
    usageControl.assertControlAllowed(settings);
    const exe = usageControl.sanitizeExePath(body.exe_path || body.exe);
    if (!exe) throw new Error("Invalid executable path");
    return usageBridge.unblockExe(exe);
  });

  safeHandle("api:lan:devices", async () => lanBridge.listDevices());
  safeHandle("api:lan:devices:refresh", async () => lanBridge.refreshDevices());
  safeHandle("api:lan:devices:update", async (_e, body = {}) => lanBridge.updateDevice(body));
  safeHandle("api:lan:devices:export", async (_e, params = {}) => {
    const destDir = app.getPath("downloads") || os.tmpdir();
    return lanBridge.exportDevices(params.format === "json" ? "json" : "csv", destDir);
  });
  safeHandle("api:lan:wol", async (_e, body = {}) => lanBridge.wakeDevice(body));
  safeHandle("api:lan:topology", async () => lanBridge.topology());
  safeHandle("api:lan:topology:stop", async () => lanBridge.stopTopology());
  safeHandle("api:lan:sniffer:status", async () => lanBridge.snifferStatus());
  safeHandle("api:lan:sniffer:start", async (_e, body = {}) => lanBridge.snifferStart(body));
  safeHandle("api:lan:sniffer:stop", async (_e, body = {}) => lanBridge.snifferStop(body));
  safeHandle("api:lan:sniffer:events", async (_e, params = {}) => lanBridge.snifferEvents(params));
  safeHandle("api:lan:scan", async (_e, body = {}) => lanBridge.scanDevice(body));
  safeHandle("api:lan:discovery", async () => lanBridge.runSubnetDiscovery());
  safeHandle("api:lan:router-notify", async (_e, body = {}) => lanBridge.notifyRouter(body));
}

function boot() {
  return TrackerDb.open().then((opened) => {
    db = opened;
    try {
      db.pruneProbes();
    } catch (err) {
      console.error("initial probe prune failed", err);
    }
    const settings = db.getSettings();
    // Settings are source of truth — re-write Run key / login item with the
    // current stable exe path (critical for portable builds).
    try {
      const on = autostart.syncFromSettings(!!settings.autostart);
      if (on !== !!settings.autostart) {
        db.updateSettings({ autostart: on });
      }
    } catch (err) {
      console.error("autostart sync failed", err);
    }

    monitor = new Monitor(db, {
      onState: onMonitorState,
      onOutage: maybeNotifyOutage,
    });
    lanBridge.init({ db, monitor });
    registerIpc();
    createWindow();
    createTray();
    monitor.start();

    try {
      lanBridge.applyIntegrationSettings({}, db.getSettings()).catch(() => {});
    } catch {
      /* ignore */
    }

    if (settings.usage_monitoring) {
      usageBridge.connect(userDataPath()).then(() => {
        startUsageRollupInterval();
      }).catch(() => {
        /* helper not running yet — enable via Settings */
      });
    }

    let openedAtLogin = false;
    try {
      openedAtLogin = !!app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      openedAtLogin = false;
    }
    // Autostart: keep monitoring in tray; don't steal focus on login.
    if (openedAtLogin && minimizeToTrayEnabled()) {
      hideToTray();
    } else {
      showDashboard();
    }
  });
}

app.on("window-all-closed", (e) => {
  // Tray mode: keep process alive with no visible window.
  if (!quitting && minimizeToTrayEnabled()) {
    e.preventDefault();
  }
});

app.on("before-quit", () => {
  quitting = true;
  stopUsageRollupInterval();
  usageBridge.stop().catch(() => {});
  try {
    lanBridge.shutdown();
  } catch {
    /* ignore */
  }
  if (monitor) monitor.stop();
  if (db) {
    try {
      db.flushPersist();
      db.close();
    } catch {
      /* ignore */
    }
  }
});
