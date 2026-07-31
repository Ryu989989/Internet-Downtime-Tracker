"use strict";

/**
 * Allow only http(s) for shell.openExternal / window-open handoff.
 * Blocks javascript:, file:, data:, etc.
 */
function isSafeExternalUrl(url) {
  if (url == null || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Stricter: https only (e.g. dashboard result links). */
function isHttpsUrl(url) {
  if (url == null || typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

module.exports = { isSafeExternalUrl, isHttpsUrl };
