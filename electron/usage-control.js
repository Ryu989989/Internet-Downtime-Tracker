"use strict";

/**
 * Phase 3: usage alerts, caps, and firewall control gating.
 * Firewall mutations go through the elevated helper when network_control_enabled.
 */

const DEFAULT_COOLDOWN_S = 3600;

function parseJsonObject(raw, fallback = {}) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * Evaluate alert rules against totals.
 * rules: { rules: [{ id, app_key|null, daily_bytes, enabled }] }
 * totalsByApp: Map/object app_key -> { bytes_in, bytes_out }
 * globalTotal: number
 */
function evaluateAlerts({ alertsJson, totalsByApp, globalTotal, nowSec, getLastFired, cooldownS = DEFAULT_COOLDOWN_S }) {
  const cfg = parseJsonObject(alertsJson, {});
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  const fires = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const id = String(rule.id || rule.rule_key || "").trim();
    if (!id) continue;
    const threshold = Number(rule.daily_bytes);
    if (!Number.isFinite(threshold) || threshold <= 0) continue;
    let used = 0;
    if (rule.app_key) {
      const row = totalsByApp[rule.app_key] || totalsByApp.get?.(rule.app_key);
      used = row ? Number(row.bytes_in || 0) + Number(row.bytes_out || 0) : 0;
    } else {
      used = Number(globalTotal) || 0;
    }
    if (used < threshold) continue;
    const last = getLastFired ? Number(getLastFired(id) || 0) : 0;
    if (last && nowSec - last < cooldownS) continue;
    fires.push({
      rule_key: id,
      app_key: rule.app_key || null,
      used,
      threshold,
      message: rule.app_key
        ? `App ${rule.app_key} used ${used} bytes (cap ${threshold})`
        : `Total usage ${used} bytes (alert ${threshold})`,
    });
  }
  return fires;
}

/**
 * Caps: { global_daily_bytes?, global_monthly_bytes?, apps?: { [app_key]: { daily_bytes?, monthly_bytes?, auto_block? } } }
 */
function evaluateCaps({ capsJson, dailyByApp, monthlyByApp, dailyGlobal, monthlyGlobal }) {
  const cfg = parseJsonObject(capsJson, {});
  const hits = [];
  const gDay = Number(cfg.global_daily_bytes);
  if (Number.isFinite(gDay) && gDay > 0 && dailyGlobal >= gDay) {
    hits.push({ scope: "global", period: "daily", used: dailyGlobal, cap: gDay, auto_block: !!cfg.auto_block });
  }
  const gMon = Number(cfg.global_monthly_bytes);
  if (Number.isFinite(gMon) && gMon > 0 && monthlyGlobal >= gMon) {
    hits.push({ scope: "global", period: "monthly", used: monthlyGlobal, cap: gMon, auto_block: !!cfg.auto_block });
  }
  const apps = cfg.apps && typeof cfg.apps === "object" ? cfg.apps : {};
  for (const [appKey, spec] of Object.entries(apps)) {
    if (!spec) continue;
    const d = Number(spec.daily_bytes);
    const dayUsed = Number(dailyByApp[appKey] || 0);
    if (Number.isFinite(d) && d > 0 && dayUsed >= d) {
      hits.push({
        scope: "app",
        app_key: appKey,
        period: "daily",
        used: dayUsed,
        cap: d,
        auto_block: !!spec.auto_block,
        exe_path: spec.exe_path || null,
      });
    }
    const m = Number(spec.monthly_bytes);
    const monUsed = Number(monthlyByApp[appKey] || 0);
    if (Number.isFinite(m) && m > 0 && monUsed >= m) {
      hits.push({
        scope: "app",
        app_key: appKey,
        period: "monthly",
        used: monUsed,
        cap: m,
        auto_block: !!spec.auto_block,
        exe_path: spec.exe_path || null,
      });
    }
  }
  return hits;
}

function assertControlAllowed(settings) {
  if (!settings || !settings.network_control_enabled) {
    const err = new Error("Network control is disabled. Enable it in Settings.");
    err.code = "CONTROL_DISABLED";
    throw err;
  }
}

function sanitizeExePath(exePath) {
  let s = String(exePath || "").trim();
  if (!s || s.length > 512) return null;
  if (/[\0\n\r"]/.test(s)) return null;
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  if (s.startsWith("\\\\.\\")) return null;
  // Reject UNC; firewall -Program needs a local drive path.
  if (s.startsWith("\\\\")) return null;
  s = s.replace(/\//g, "\\");
  while (s.includes("\\\\")) s = s.replace(/\\\\/g, "\\");
  if (!/^[a-zA-Z]:\\/.test(s)) return null;
  if (s.includes("..")) return null;
  if (!/\.exe$/i.test(s)) return null;
  return s;
}

module.exports = {
  parseJsonObject,
  evaluateAlerts,
  evaluateCaps,
  assertControlAllowed,
  sanitizeExePath,
  DEFAULT_COOLDOWN_S,
};
