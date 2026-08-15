"use strict";

const DAY_S = 86400;

/**
 * fail_reason is NOT stored on monitor snapshot/state (would need _applyProbe/_tick).
 * lastFailReason() always returns null. Pill tips use only: lan_ok, wan_ok, dns_ok,
 * http_ok, latency_ms (combined, not per-layer), failure_domain, last_probe_at,
 * quality (burst), http_cert_days / http_url when parent copies them.
 */

/** Earliest finite unix-sec among history clocks. Session `started_at` is not history. */
function observationStart({ observeSince = null, firstProbeAt = null, firstOutageAt = null } = {}) {
  let start = null;
  for (const v of [firstProbeAt, firstOutageAt, observeSince]) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) continue;
    if (start == null || n < start) start = n;
  }
  return start;
}

function observedDays({ nowSec, observeSince, firstProbeAt, firstOutageAt }) {
  const start = observationStart({ observeSince, firstProbeAt, firstOutageAt });
  if (start == null) return null;
  return Math.max(0, (nowSec - start) / DAY_S);
}

function pctWindowLabel(days) {
  if (days == null || !Number.isFinite(days)) return null;
  if (days >= 30) return "30d";
  if (days < 1) return "<1d";
  return `${Math.floor(days)}d`;
}

function probeSparkLabel(probeRetentionDays = 14) {
  const n = Number(probeRetentionDays);
  const days = Number.isFinite(n) && n > 0 ? n : 14;
  return `${days}d`;
}

function formatHttpCertDays(certDays, url) {
  let protocol = null;
  if (url) {
    try {
      protocol = new URL(String(url)).protocol;
    } catch {
      protocol = null;
    }
  }
  if (protocol === "http:") return "N/A (HTTP URL)";
  if (certDays == null || !Number.isFinite(Number(certDays))) return "N/A";
  return String(Math.trunc(Number(certDays)));
}

function lastFailReason(_state) {
  return null;
}

function flag(ok) {
  return ok === true ? "up" : ok === false ? "down" : "unknown";
}

function layerPillTips(state = {}) {
  const combined =
    state.latency_ms != null && Number.isFinite(Number(state.latency_ms))
      ? `Combined latency ${Math.round(Number(state.latency_ms))} ms (not per-layer).`
      : "No combined latency.";
  const domain = state.failure_domain
    ? `Failure domain: ${state.failure_domain}.`
    : "No open failure domain.";
  const probed =
    state.last_probe_at != null && Number.isFinite(Number(state.last_probe_at))
      ? `Last probe ${new Date(Number(state.last_probe_at) * 1000).toISOString()}.`
      : "No probe yet.";
  let quality = "";
  const q = state.quality;
  if (q && typeof q === "object") {
    const bits = [];
    if (q.loss_pct != null) bits.push(`loss ${q.loss_pct}%`);
    if (q.jitter_ms != null) bits.push(`jitter ${q.jitter_ms} ms`);
    if (bits.length) {
      quality = ` Quality burst (${q.target || "host"}): ${bits.join(", ")}.`;
    }
  }
  const common = `${combined} ${domain} ${probed}${quality}`;
  const cert = formatHttpCertDays(state.http_cert_days, state.http_url);
  return {
    lan: `LAN ${flag(state.lan_ok)}. ${common}`,
    wan: `WAN ${flag(state.wan_ok)}. ${common}`,
    dns: `DNS ${flag(state.dns_ok)}. ${common}`,
    http: `HTTP ${flag(state.http_ok)}. Cert ${cert}. ${common}`,
  };
}

function honestUptimeBar(summary = {}, opts = {}) {
  const {
    probeRetentionDays = 14,
    nowSec = Date.now() / 1000,
    observeSince = null,
    firstProbeAt = null,
    firstOutageAt = null,
  } = opts;
  const win = (summary.windows && summary.windows["30d"] && summary.windows["30d"].all) || {};
  const downtimePct = Number(win.downtime_pct) || 0;
  const uptimePct = Math.round((100 - downtimePct) * 1000) / 1000;
  const days = observedDays({ nowSec, observeSince, firstProbeAt, firstOutageAt });
  const sparkLabel = probeSparkLabel(probeRetentionDays);
  return {
    uptime_pct: uptimePct,
    downtime_pct: Math.round(downtimePct * 1000) / 1000,
    downtime_ms: win.downtime_ms || 0,
    outage_count: win.count || 0,
    pct_label: pctWindowLabel(days),
    sparkline_24h: Array.isArray(summary.sparkline_24h) ? summary.sparkline_24h : [],
    sparkline_24h_label: "24h",
    probe_spark_label: sparkLabel,
    probe_retention_days: Number(sparkLabel.slice(0, -1)),
  };
}

module.exports = {
  honestUptimeBar,
  observationStart,
  pctWindowLabel,
  probeSparkLabel,
  formatHttpCertDays,
  lastFailReason,
  layerPillTips,
};
