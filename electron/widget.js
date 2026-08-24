"use strict";

/**
 * Frameless desktop overlay window. Geometry persistence is a callback
 * (onBoundsChanged) so this module never touches db.
 */

const MIN_WIDTH = 220;
const MIN_HEIGHT = 88;
const MAX_WIDTH = 720;
const MAX_HEIGHT = 480;
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 220;
const INSET_PX = 16;
const BOUNDS_DEBOUNCE_MS = 300;

let win = null;
let persistTimer = null;
let applyingBounds = false;
let destroying = false;
let onBoundsChanged = null;
let onClosed = null;
let electronScreen = null;
let lastSettings = null;

function toInt(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function primaryWorkArea(screenMod) {
  if (screenMod && typeof screenMod.getPrimaryDisplay === "function") {
    const d = screenMod.getPrimaryDisplay();
    if (d && d.workArea) return d.workArea;
  }
  return { x: 0, y: 0, width: 1920, height: 1080 };
}

function allWorkAreas(screenMod) {
  if (screenMod && typeof screenMod.getAllDisplays === "function") {
    const areas = (screenMod.getAllDisplays() || [])
      .map((d) => d && d.workArea)
      .filter(Boolean);
    if (areas.length) return areas;
  }
  return [primaryWorkArea(screenMod)];
}

function containsPoint(wa, px, py) {
  return px >= wa.x && py >= wa.y && px < wa.x + wa.width && py < wa.y + wa.height;
}

function pickWorkArea(x, y, width, height, screenMod) {
  const areas = allWorkAreas(screenMod);
  const cx = x + width / 2;
  const cy = y + height / 2;
  for (const wa of areas) {
    if (containsPoint(wa, cx, cy)) return wa;
  }
  let best = null;
  let bestArea = 0;
  for (const wa of areas) {
    const ix = Math.max(x, wa.x);
    const iy = Math.max(y, wa.y);
    const iw = Math.min(x + width, wa.x + wa.width) - ix;
    const ih = Math.min(y + height, wa.y + wa.height) - iy;
    const a = Math.max(0, iw) * Math.max(0, ih);
    if (a > bestArea) {
      bestArea = a;
      best = wa;
    }
  }
  if (best) return best;
  let nearest = areas[0];
  let dist = Infinity;
  for (const wa of areas) {
    const wcx = wa.x + wa.width / 2;
    const wcy = wa.y + wa.height / 2;
    const d = (cx - wcx) ** 2 + (cy - wcy) ** 2;
    if (d < dist) {
      dist = d;
      nearest = wa;
    }
  }
  return nearest;
}

function clampSize(width, height, wa) {
  let w = clamp(toInt(width, DEFAULT_WIDTH), MIN_WIDTH, MAX_WIDTH);
  let h = clamp(toInt(height, DEFAULT_HEIGHT), MIN_HEIGHT, MAX_HEIGHT);
  w = Math.min(w, wa.width);
  h = Math.min(h, wa.height);
  w = Math.max(w, Math.min(MIN_WIDTH, wa.width));
  h = Math.max(h, Math.min(MIN_HEIGHT, wa.height));
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/** Fit x/y/w/h into a visible display workArea (multi-monitor). */
function clampBounds(bounds, screenMod) {
  const b = bounds || {};
  const guessW = clamp(toInt(b.width, DEFAULT_WIDTH), MIN_WIDTH, MAX_WIDTH);
  const guessH = clamp(toInt(b.height, DEFAULT_HEIGHT), MIN_HEIGHT, MAX_HEIGHT);
  const x0 = toInt(b.x, 0);
  const y0 = toInt(b.y, 0);
  const wa = pickWorkArea(x0, y0, guessW, guessH, screenMod);
  const { width, height } = clampSize(guessW, guessH, wa);
  const maxX = wa.x + wa.width - width;
  const maxY = wa.y + wa.height - height;
  const x = width >= wa.width ? wa.x : clamp(x0, wa.x, Math.max(wa.x, maxX));
  const y = height >= wa.height ? wa.y : clamp(y0, wa.y, Math.max(wa.y, maxY));
  return { x, y, width, height };
}

/** Primary workArea, bottom-right, 16px inset. */
function defaultBounds(screenMod) {
  const wa = primaryWorkArea(screenMod);
  const { width, height } = clampSize(DEFAULT_WIDTH, DEFAULT_HEIGHT, wa);
  return clampBounds(
    {
      x: wa.x + wa.width - width - INSET_PX,
      y: wa.y + wa.height - height - INSET_PX,
      width,
      height,
    },
    screenMod
  );
}

function hasSavedPosition(settings) {
  if (!settings) return false;
  return Number.isFinite(Number(settings.widget_x)) && Number.isFinite(Number(settings.widget_y));
}

function boundsFromSettings(settings, screenMod) {
  const width = settings && settings.widget_width != null ? settings.widget_width : DEFAULT_WIDTH;
  const height = settings && settings.widget_height != null ? settings.widget_height : DEFAULT_HEIGHT;
  if (!hasSavedPosition(settings)) {
    const wa = primaryWorkArea(screenMod);
    const sized = clampSize(width, height, wa);
    return clampBounds(
      {
        x: wa.x + wa.width - sized.width - INSET_PX,
        y: wa.y + wa.height - sized.height - INSET_PX,
        width: sized.width,
        height: sized.height,
      },
      screenMod
    );
  }
  return clampBounds(
    { x: settings.widget_x, y: settings.widget_y, width, height },
    screenMod
  );
}

function alwaysOnTopFrom(settings) {
  if (!settings || settings.widget_always_on_top == null) return true;
  return !!settings.widget_always_on_top;
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function getWindow() {
  return isOpen() ? win : null;
}

function clearPersistTimer() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function detachDisplayListeners() {
  if (!electronScreen) return;
  electronScreen.removeListener("display-metrics-changed", reclampToWorkArea);
  electronScreen.removeListener("display-added", reclampToWorkArea);
  electronScreen.removeListener("display-removed", reclampToWorkArea);
  electronScreen = null;
}

function attachDisplayListeners(screenMod) {
  detachDisplayListeners();
  electronScreen = screenMod;
  screenMod.on("display-metrics-changed", reclampToWorkArea);
  screenMod.on("display-added", reclampToWorkArea);
  screenMod.on("display-removed", reclampToWorkArea);
}

function applyClampedBounds(next) {
  if (!isOpen()) return next;
  applyingBounds = true;
  try {
    win.setBounds(next);
  } finally {
    applyingBounds = false;
  }
  return next;
}

function persistBounds(next) {
  if (typeof onBoundsChanged !== "function") return;
  onBoundsChanged({ x: next.x, y: next.y, width: next.width, height: next.height });
}

function currentClampedBounds() {
  if (!isOpen()) return null;
  const screenMod = electronScreen || require("electron").screen;
  return clampBounds(win.getBounds(), screenMod);
}

function reclampToWorkArea() {
  if (!isOpen()) return;
  const next = currentClampedBounds();
  if (!next) return;
  applyClampedBounds(next);
  persistBounds(next);
}

function scheduleBoundsPersist() {
  if (!isOpen() || applyingBounds) return;
  clearPersistTimer();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!isOpen() || applyingBounds) return;
    const next = currentClampedBounds();
    if (!next) return;
    const cur = win.getBounds();
    if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) {
      applyClampedBounds(next);
    }
    persistBounds(next);
  }, BOUNDS_DEBOUNCE_MS);
}

function setAlwaysOnTop(flag) {
  if (!isOpen()) return;
  win.setAlwaysOnTop(!!flag);
}

function sendPrefs(settings) {
  if (!isOpen() || !settings) return;
  push("widget:prefs", {
    widget_fill_pct: settings.widget_fill_pct,
    widget_modules_json: settings.widget_modules_json,
  });
}

function applyPrefs(settings) {
  if (settings) lastSettings = settings;
  if (!isOpen() || !settings) return;
  setAlwaysOnTop(alwaysOnTopFrom(settings));
  const screenMod = electronScreen || require("electron").screen;
  const cur = win.getBounds();
  const merged = { ...settings };
  if (!hasSavedPosition(settings)) {
    merged.widget_x = cur.x;
    merged.widget_y = cur.y;
  }
  const next = boundsFromSettings(merged, screenMod);
  if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) {
    applyClampedBounds(next);
  }
  sendPrefs(settings);
}

function push(channel, data) {
  if (!isOpen() || !channel) return false;
  try {
    win.webContents.send(channel, data);
    return true;
  } catch {
    return false;
  }
}

function teardownWindowRef() {
  clearPersistTimer();
  detachDisplayListeners();
  win = null;
}

function destroy() {
  destroying = true;
  clearPersistTimer();
  detachDisplayListeners();
  if (win && !win.isDestroyed()) {
    win.removeAllListeners("closed");
    win.destroy();
  }
  win = null;
  destroying = false;
}

function create(opts) {
  const {
    settings = {},
    preloadPath,
    htmlPath,
    iconPath,
    onBoundsChanged: boundsCb,
    onClosed: closedCb,
  } = opts || {};

  if (!preloadPath) throw new Error("widget.create: preloadPath required");
  if (!htmlPath) throw new Error("widget.create: htmlPath required");

  onBoundsChanged = typeof boundsCb === "function" ? boundsCb : null;
  onClosed = typeof closedCb === "function" ? closedCb : null;
  lastSettings = settings;

  if (isOpen()) {
    applyPrefs(settings);
    return win;
  }

  const { BrowserWindow, screen } = require("electron");
  const bounds = boundsFromSettings(settings, screen);

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    skipTaskbar: true,
    resizable: true,
    show: false,
    alwaysOnTop: alwaysOnTopFrom(settings),
    fullscreenable: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Overlay must keep receiving status:update while unfocused.
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.on("move", scheduleBoundsPersist);
  win.on("resize", scheduleBoundsPersist);
  win.on("closed", () => {
    const notify = !destroying && typeof onClosed === "function";
    teardownWindowRef();
    if (notify) onClosed();
  });

  attachDisplayListeners(screen);
  win.loadFile(htmlPath);
  win.webContents.on("did-finish-load", () => {
    if (!isOpen()) return;
    sendPrefs(lastSettings);
  });
  win.once("ready-to-show", () => {
    if (!isOpen()) return;
    win.setAlwaysOnTop(alwaysOnTopFrom(settings));
    win.showInactive();
    sendPrefs(lastSettings);
  });

  return win;
}

module.exports = {
  create,
  destroy,
  isOpen,
  applyPrefs,
  setAlwaysOnTop,
  getWindow,
  push,
  clampBounds,
  defaultBounds,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
};
