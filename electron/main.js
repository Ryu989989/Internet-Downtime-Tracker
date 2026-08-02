"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification } = require("electron");

const { TrackerDb } = require("./db");
const { Monitor } = require("./monitor");
const autostart = require("./autostart");
const { trayIcon, stateColor, resolveAppIconPath } = require("./icons");
const systemLogs = require("./system-logs");
const speedtest = require("./speedtest");
const { isHttpsUrl } = require("./url-policy");
const { buildEvidenceCsv, buildHtmlReport, fmtDuration } = require("./export");

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

function createWindow() {
  const iconPath = resolveAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
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
  if (!settings.toast_alerts) return;
  if (!Notification.isSupported()) return;
  const type = String(event.type || "outage").toUpperCase();
  if (event.action === "open") {
    new Notification({
      title: `${type} outage started`,
      body: "Connectivity check failed after debounce.",
    }).show();
    return;
  }
  if (event.action === "close") {
    const dur =
      event.duration_ms != null ? fmtDuration(event.duration_ms) : "unknown duration";
    new Notification({
      title: `${type} outage ended`,
      body: `Recovered · ${dur}`,
    }).show();
  }
}

function registerIpc() {
  safeHandle("api:status", () => monitor.snapshot());
  safeHandle("api:summary", () =>
    db.summary(null, { observeSince: monitor.state.started_at })
  );
  safeHandle("api:settings", () => db.getSettings());
  safeHandle("api:settings:update", (_e, body) => {
    const updated = db.updateSettings(body || {});
    if (Object.prototype.hasOwnProperty.call(body || {}, "autostart")) {
      try {
        autostart.setEnabled(!!updated.autostart);
      } catch (err) {
        console.error("autostart update failed", err);
      }
      if (tray) tray.setContextMenu(buildTrayMenu());
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
    const rows = db.listSpeedTests({
      fromTs: params.from != null ? Number(params.from) : null,
      toTs: params.to != null ? Number(params.to) : null,
      limit: params.limit != null ? Number(params.limit) : 100,
    });
    return { tests: rows, count: rows.length, latest: db.latestSpeedTest() };
  });
  safeHandle("api:speedtest:run", async () => {
    if (monitor) monitor.setProbeSuppress(true);
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
    } finally {
      // Cool-down ignores failure streaks after saturated-link blips.
      if (monitor) monitor.setProbeSuppress(false, { cooldownMs: 8000 });
    }
  });
  safeHandle("api:speedtest:cancel", () => {
    const ok = speedtest.cancelRun();
    if (monitor) monitor.setProbeSuppress(false, { cooldownMs: 8000 });
    return ok;
  });
  safeHandle("api:speedtest:install", async () => {
    const installed = await speedtest.installOfficialCli(userData());
    return { ...installed, ...(await speedtest.getStatus(userData())) };
  });
}

function boot() {
  return TrackerDb.open().then((opened) => {
    db = opened;
    const settings = db.getSettings();
    const registryOn = autostart.isEnabled();
    if (Boolean(settings.autostart) !== registryOn) {
      db.updateSettings({ autostart: registryOn });
    }

    monitor = new Monitor(db, {
      onState: onMonitorState,
      onOutage: maybeNotifyOutage,
    });
    registerIpc();
    createWindow();
    createTray();
    monitor.start();
    showDashboard();
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
  if (monitor) monitor.stop();
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
});
