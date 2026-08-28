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
const { honestUptimeBar, observationStart } = require("./uptime-bar");
const { startCustomMonitors, stopCustomMonitors, customMonitorStatus, parseMonitors } = require("./custom-monitors");
const { createSpeedtestScheduler } = require("./speedtest-scheduler");
const { traceroutePublic } = require("./traceroute");
const notifyChannels = require("./notify-webhooks");
const widget = require("./widget");
const { statusHeadline, layerLatencyLine } = require("./status-copy");

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
let speedtestScheduler = null;
/** In-memory last-3 widget events (not persisted). */
const recentEvents = [];
const WIDGET_IPC_CHANNELS = new Set([
  "api:status",
  "api:settings",
  "api:widget:openDashboard",
  "api:widget:bounds",
]);

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

function isMainSender(event) {
  return !!(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function isWidgetSender(event) {
  const w = widget.getWindow();
  return !!(w && !w.isDestroyed() && event.sender === w.webContents);
}

function senderAllowed(event, channel) {
  if (!event || event.sender.isDestroyed()) return false;
  if (isMainSender(event)) return true;
  return isWidgetSender(event) && WIDGET_IPC_CHANNELS.has(channel);
}

function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!senderAllowed(event, channel)) return null;
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

function pushRecent(kind, title, detail) {
  recentEvents.push({
    at: Date.now() / 1000,
    kind: String(kind || ""),
    title: String(title || ""),
    detail: String(detail || ""),
  });
  if (recentEvents.length > 3) recentEvents.splice(0, recentEvents.length - 3);
  pushStatusUpdate();
}

function lastSpeedPayload() {
  if (!db || typeof db.latestSpeedTest !== "function") return null;
  try {
    const row = db.latestSpeedTest();
    if (!row) return null;
    return {
      isp: row.isp || null,
      server_name: row.server_name || null,
      ping_ms: row.ping_ms != null ? Number(row.ping_ms) : null,
      tested_at: row.tested_at,
      download_mbps: row.download_mbps != null ? Number(row.download_mbps) : null,
      upload_mbps: row.upload_mbps != null ? Number(row.upload_mbps) : null,
    };
  } catch {
    return null;
  }
}

function decorateSnapshot(snap) {
  if (!snap) return snap;
  const out = { ...snap, recent_events: recentEvents.slice() };
  try {
    const s = db ? db.getSettings() : null;
    out.quiet_hours_active = !!(
      s &&
      notifyChannels.inQuietHours(notifyChannels.parseQuietHours(s.notify_quiet_hours_json))
    );
    if (s) {
      out.widget_fill_pct = s.widget_fill_pct;
      out.widget_modules_json = s.widget_modules_json;
    }
  } catch {
    out.quiet_hours_active = false;
  }
  out.last_speed = lastSpeedPayload();
  if (monitor) out.state_color = stateColor(monitor.state);
  try {
    out.host_adapter = lanBridge.getHostAdapter();
    out.overview_wifi = lanBridge.overviewWifiPayload(snap.adapter);
    if (typeof lanBridge.liveWifiVerdict === "function") {
      out.wifi_verdict = lanBridge.liveWifiVerdict();
    }
  } catch {
    /* fail closed — Overview stays on host NIC */
  }
  return out;
}

function persistWidgetBounds(bounds) {
  if (!db || quitting || !bounds) return;
  try {
    db.updateSettings({
      widget_x: bounds.x,
      widget_y: bounds.y,
      widget_width: bounds.width,
      widget_height: bounds.height,
    });
  } catch (err) {
    console.error("widget bounds persist failed", err);
  }
}

function syncWidget(settings) {
  const s = settings || (db ? db.getSettings() : null) || {};
  if (!s.widget_enabled) {
    widget.destroy();
    return;
  }
  widget.create({
    settings: s,
    preloadPath: path.join(__dirname, "preload-widget.js"),
    htmlPath: path.join(__dirname, "..", "web", "widget.html"),
    iconPath: resolveAppIconPath(),
    onBoundsChanged: persistWidgetBounds,
    onClosed: () => {
      if (quitting || !db) return;
      try {
        db.updateSettings({ widget_enabled: false });
      } catch {
        /* ignore */
      }
      if (tray) {
        try {
          tray.setContextMenu(buildTrayMenu());
        } catch {
          /* ignore */
        }
      }
    },
  });
  pushStatusUpdate();
}

function applyWidgetFromSettingsBody(body, updated) {
  if (!body || !updated) return;
  const touched = Object.keys(body).some((k) => String(k).startsWith("widget_"));
  if (!touched) return;
  syncWidget(updated);
  if (tray && Object.prototype.hasOwnProperty.call(body, "widget_enabled")) {
    try {
      tray.setContextMenu(buildTrayMenu());
    } catch {
      /* ignore */
    }
  }
}

function hookCustomMonitors() {
  startCustomMonitors({
    db,
    monitor,
    onFlip: (info) => {
      pushRecent("monitor", info && info.title, info && info.detail);
    },
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
  app.whenReady().then(() => {
    autostart.unregisterApplicationRestart();
    setTimeout(() => autostart.unregisterApplicationRestart(), 4000);
    return boot();
  }).catch((err) => {
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
    if (widget.isOpen()) {
      return;
    }
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
      label: "Show desktop widget",
      type: "checkbox",
      checked: !!(db && db.getSettings().widget_enabled),
      click: (item) => {
        if (!db) return;
        try {
          const updated = db.updateSettings({ widget_enabled: !!item.checked });
          syncWidget(updated);
        } catch (err) {
          console.error(err);
        }
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
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
  if (!monitor) return;
  let payload;
  try {
    payload = decorateSnapshot(monitor.snapshot());
  } catch (err) {
    if (!isBenignPipeError(err)) {
      try {
        console.error("status:update snapshot failed", err);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const wc = mainWindow.webContents;
      if (wc && !wc.isDestroyed()) wc.send("status:update", payload);
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
  widget.push("status:update", payload);
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
  const snap = monitor.snapshot();
  const head = statusHeadline(snap);
  const layerLine = layerLatencyLine(snap);
  event.status_title = head.title;
  event.lan_ok = snap.lan_ok;
  event.wan_ok = snap.wan_ok;
  event.dns_ok = snap.dns_ok;
  event.http_ok = snap.http_ok;
  event.latency_ms = snap.latency_ms;
  if (settings.toast_alerts && Notification.isSupported()) {
    if (event.action === "open") {
      new Notification({
        title: head.title,
        body: layerLine,
      }).show();
    } else if (event.action === "close") {
      const dur =
        event.duration_ms != null ? fmtDuration(event.duration_ms) : "unknown duration";
      new Notification({
        title: head.title,
        body: `Recovered · ${dur} · ${layerLine}`,
      }).show();
    }
  }
  pushRecent(
    "outage",
    event.action === "close" ? "Recovered" : head.title,
    event.action === "close"
      ? `${String(event.type || "outage").toUpperCase()}${
          event.duration_ms != null ? " · " + fmtDuration(event.duration_ms) : ""
        }`
      : layerLine
  );
  lanBridge
    .onOutageEvent(event.action === "open" ? "outage_open" : "outage_close", event)
    .then(() => {
      if (event.id == null || !db || typeof db.mergeOutageSnapshot !== "function") return;
      try {
        const row = db._get("SELECT * FROM outages WHERE id=?", [event.id]);
        const v =
          typeof lanBridge.wifiVerdictForOutage === "function"
            ? lanBridge.wifiVerdictForOutage(row || event)
            : null;
        if (v) db.mergeOutageSnapshot(event.id, { wifi_verdict: v });
      } catch {
        /* fail closed */
      }
    })
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
  const toastNewExe = !!db.getSettings().toast_alerts;
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
      if (!existing && toastNewExe && Notification.isSupported()) {
        try {
          new Notification({
            title: "New app seen",
            body: name || appKey,
          }).show();
        } catch {
          /* ignore */
        }
        pushRecent("usage", "New app seen", name || appKey);
      }
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
    pushRecent("usage", "Usage alert", fire.message || "Usage threshold reached");
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
    pushRecent("usage", "Usage cap", capBody);
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

/** History clock for summary/streak — MIN(first probe, first outage), never session start. */
function historyObservationClocks() {
  const firstProbe = db._get("SELECT MIN(timestamp) AS t FROM probes");
  const firstOutage = db.listOutages({ orderBy: "started_at", orderDir: "ASC", limit: 1 })[0];
  const firstProbeAt = firstProbe && firstProbe.t != null ? Number(firstProbe.t) : null;
  const firstOutageAt =
    firstOutage && firstOutage.started_at != null ? Number(firstOutage.started_at) : null;
  return {
    firstProbeAt,
    firstOutageAt,
    observeSince: observationStart({ firstProbeAt, firstOutageAt }),
  };
}

function registerIpc() {
  safeHandle("api:status", () => decorateSnapshot(monitor.snapshot()));
  safeHandle("api:widget:openDashboard", () => {
    showDashboard();
    return { ok: true };
  });
  safeHandle("api:widget:bounds", (_e, body = {}) => {
    persistWidgetBounds({
      x: body.x,
      y: body.y,
      width: body.width,
      height: body.height,
    });
    return { ok: true };
  });
  safeHandle("api:monitors:status", () => {
    const monitors = db ? parseMonitors(db.getSettings()) : [];
    const history = db ? db.listMonitorChecks({ limit: 1000 }) : [];
    return { monitors, status: customMonitorStatus(), history };
  });
  safeHandle("api:summary", () => {
    const settings = db.getSettings();
    const { firstProbeAt, firstOutageAt, observeSince } = historyObservationClocks();
    const sum = db.summary(null, { observeSince });
    const retention = settings.probe_retention_days ?? 14;
    return {
      ...sum,
      observe_since: observeSince,
      probe_retention_days: retention,
      uptime_bar: honestUptimeBar(sum, {
        probeRetentionDays: retention,
        firstProbeAt,
        firstOutageAt,
      }),
    };
  });
  safeHandle("api:settings", () => db.getSettingsPublic());
  safeHandle("api:settings:update", async (_e, body) => {
    const prev = db.getSettings();
    const updated = db.updateSettings(body || {});
    if (Object.prototype.hasOwnProperty.call(body || {}, "speedtest_interval_min")) {
      if (speedtestScheduler) speedtestScheduler.startSpeedtestScheduler();
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, "monitors_json")) {
      hookCustomMonitors();
    }
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
    applyWidgetFromSettingsBody(body || {}, updated);
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
    const outages = rows.map((row) => {
      let verdict = null;
      if (row && row.snapshot_json) {
        try {
          const snap = JSON.parse(row.snapshot_json);
          if (snap && snap.wifi_verdict) verdict = snap.wifi_verdict;
        } catch {
          /* ignore */
        }
      }
      if (!verdict && row && row.type === "lan" && typeof lanBridge.wifiVerdictForOutage === "function") {
        try {
          verdict = lanBridge.wifiVerdictForOutage(row);
        } catch {
          verdict = null;
        }
      }
      return verdict ? { ...row, wifi_verdict: verdict } : row;
    });
    return { outages, count: outages.length };
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
    const { observeSince } = historyObservationClocks();
    const summary = db.summary(now, { observeSince });
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
  safeHandle("api:speedtest:run", async () => speedtestScheduler.runSpeedTestAndStore());
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
      resolveDns: !!settings.connections_resolve_dns,
      trackDelta: true,
      trackAdapters: true,
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
  safeHandle("api:lan:devices:ping", async (_e, body = {}) =>
    lanBridge.lanDevices.pingDevice(body || {})
  );
  safeHandle("api:lan:devices:traceroute", async (_e, body = {}) =>
    lanBridge.lanDevices.tracerouteDevice(body || {})
  );
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
  safeHandle("api:lan:router:test", async (_e, targetId) => lanBridge.testRouterConnection(targetId));
  safeHandle("api:lan:router:action", async (_e, body = {}) => lanBridge.routerAction(body || {}));
  safeHandle("api:lan:wifi:history", async (_e, body = {}) => lanBridge.listWifiHistory(body || {}));
  safeHandle("api:lan:router:health", async () => lanBridge.getRouterHealth());
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
      onDegradation: (ev) => {
        pushRecent("degradation", ev && ev.title, "");
      },
      tracerouteFn: traceroutePublic,
    });
    lanBridge.init({
      db,
      monitor,
      onRecentEvent: (ev) => {
        pushRecent(ev && ev.kind, ev && ev.title, ev && ev.detail);
      },
    });
    speedtestScheduler = createSpeedtestScheduler({ db, monitor, speedtest, usageBridge, userDataPath: () => app.getPath("userData") });
    registerIpc();
    createWindow();
    createTray();
    monitor.start();
    speedtestScheduler.startSpeedtestScheduler();
    hookCustomMonitors();

    // Flush any queued quiet-hours digests once quiet hours end, even if the
    // user does not change settings.
    setInterval(() => {
      try {
        const s = db.getSettings();
        if (
          notifyChannels.pendingDigestCount() &&
          !notifyChannels.inQuietHours(notifyChannels.parseQuietHours(s.notify_quiet_hours_json))
        ) {
          notifyChannels.flushDigest({ urls: s.notify_webhooks_json, settings: s }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }, 60_000).unref?.();

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
    syncWidget(db.getSettings());
  });
}

app.on("window-all-closed", (e) => {
  if (!quitting && (minimizeToTrayEnabled() || widget.isOpen())) {
    e.preventDefault();
  }
});

app.on("before-quit", () => {
  quitting = true;
  widget.destroy();
  if (speedtestScheduler) speedtestScheduler.stopSpeedtestScheduler();
  stopCustomMonitors();
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
