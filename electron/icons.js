"use strict";

const fs = require("fs");
const path = require("path");
const { nativeImage } = require("electron");

const PALETTE = {
  green: [62, 207, 142],
  amber: [230, 180, 80],
  red: [240, 113, 120],
  gray: [120, 130, 140],
};

/** Map internal tray colors → generated asset basenames. */
const TRAY_FILES = {
  green: "tray-ok.png",
  amber: "tray-warn.png",
  red: "tray-down.png",
  gray: "tray-paused.png",
};

function iconsDir() {
  return path.join(__dirname, "..", "assets", "icons");
}

function firstExisting(...names) {
  const dir = iconsDir();
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** App / window / installer icon path, or null if none on disk. */
function resolveAppIconPath() {
  return firstExisting("icon.ico", "app-icon.ico", "app-icon.png", "icon.png");
}

/** Build a solid-circle tray icon (BGRA bitmap for Electron/Windows). */
function circleIcon(r, g, b, size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rad = size / 2 - 2;
  const rad2 = rad * rad;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const i = (y * size + x) * 4;
      if (dx * dx + dy * dy <= rad2) {
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function trayIconFromFile(color) {
  const file = TRAY_FILES[color] || TRAY_FILES.gray;
  const p = firstExisting(file);
  if (!p) return null;
  try {
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    return img;
  } catch {
    return null;
  }
}

function trayIcon(color) {
  const fromFile = trayIconFromFile(color);
  if (fromFile) return fromFile;
  const rgb = PALETTE[color] || PALETTE.gray;
  return circleIcon(rgb[0], rgb[1], rgb[2], 32);
}

function stateColor(state) {
  if (state.paused || state.lan_ok == null) return "gray";
  if (state.lan_ok === false) return "red";
  if (state.wan_ok === false) return "amber";
  if (state.dns_ok === false || state.http_ok === false) return "amber";
  return "green";
}

module.exports = {
  trayIcon,
  stateColor,
  PALETTE,
  resolveAppIconPath,
  iconsDir,
  TRAY_FILES,
};
