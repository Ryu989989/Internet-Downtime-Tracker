"use strict";

const path = require("path");
const { app, BrowserWindow, Tray, Menu, ipcMain } = require("electron");

const { TrackerDb } = require("./db");
const { Monitor } = require("./monitor");
const autostart = require("./autostart");
const { trayIcon, stateColor } = require("./icons");

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    backgroundColor: "#0f1419",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "Internet Downtime Tracker",
  });

  mainWindow.loadFile(webIndex());

  mainWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
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

function onMonitorState(state) {
  const color = stateColor(state);
  if (color === iconColor || !tray) return;
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
}

function boot() {
  return TrackerDb.open().then((opened) => {
    db = opened;
    const settings = db.getSettings();
    const registryOn = autostart.isEnabled();
    if (Boolean(settings.autostart) !== registryOn) {
      db.updateSettings({ autostart: registryOn });
    }

    monitor = new Monitor(db, { onState: onMonitorState });
    registerIpc();
    createWindow();
    createTray();
    monitor.start();
    showDashboard();
  });
}

app.on("window-all-closed", (e) => {
  // Keep running in tray on Windows
  e.preventDefault();
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
