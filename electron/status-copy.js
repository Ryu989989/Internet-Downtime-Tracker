"use strict";

/** Headline/sub from a monitor snapshot — same order and copy as Overview paintStatus. */
function statusHeadline(snapshot) {
  const s = snapshot || {};
  if (s.paused) {
    return {
      title: "Paused",
      sub: "Monitoring is paused. Resume from Settings or the tray",
    };
  }
  if (s.monitor_stale) {
    return {
      title: "Monitor stalled",
      sub: "The last probe is older than expected. Check Pause or restart",
    };
  }
  if (s.probe_suppressed) {
    return {
      title: "Speed test running",
      sub: "Probes paused so the test won’t pollute History",
    };
  }
  if (s.lan_ok === false) {
    return {
      title: "LAN down",
      sub: "Gateway unreachable. A local network issue is likely",
    };
  }
  if (s.wan_ok === false) {
    return {
      title: "WAN down",
      sub: "LAN up, public internet unreachable",
    };
  }
  if (s.dns_ok === false) {
    return {
      title: "DNS down",
      sub: "TCP path up, DNS resolution failing",
    };
  }
  if (s.http_ok === false) {
    return {
      title: "HTTP path down",
      sub: "DNS OK, web connectivity check failing (captive portal?)",
    };
  }
  if (s.lan_ok == null || s.wan_ok == null) {
    return {
      title: "Warming up",
      sub: "Waiting for first probe results",
    };
  }
  return {
    title: "All clear",
    sub: "LAN, WAN, DNS, and HTTP path OK",
  };
}

function layerFlag(ok, name) {
  if (ok === true) return `${name} up`;
  if (ok === false) return `${name} down`;
  return `${name} -`;
}

function layerFlagShort(ok) {
  if (ok === true) return "UP";
  if (ok === false) return "DOWN";
  return "-";
}

function layerKind(ok) {
  if (ok === true) return "ok";
  if (ok === false) return "down";
  return "unknown";
}

/** Same LAN/WAN/DNS/HTTP pill rules as Overview paintStatus. */
function layerPills(snapshot) {
  const s = snapshot || {};
  const pills = {
    lan: { text: `LAN ${layerFlagShort(s.lan_ok)}`, kind: layerKind(s.lan_ok) },
    wan: { text: `WAN ${layerFlagShort(s.wan_ok)}`, kind: layerKind(s.wan_ok) },
    dns: { text: `DNS ${layerFlagShort(s.dns_ok)}`, kind: layerKind(s.dns_ok) },
    http: { text: `HTTP ${layerFlagShort(s.http_ok)}`, kind: layerKind(s.http_ok) },
  };
  if (s.lan_ok === false) {
    pills.wan = {
      text: `WAN ${s.wan_ok === true ? "UP" : "DOWN"}`,
      kind: s.wan_ok === true ? "ok" : "amber",
    };
  }
  if (s.lan_ok !== true || s.wan_ok !== true) {
    pills.dns = { text: "DNS -", kind: "unknown" };
  }
  if (s.lan_ok !== true || s.wan_ok !== true || s.dns_ok !== true) {
    pills.http = { text: "HTTP -", kind: "unknown" };
  }
  return pills;
}

/** LAN/WAN/DNS/HTTP + gateway + latency, for toast/webhook bodies. */
function layerLatencyLine(snapshot) {
  const s = snapshot || {};
  const bits = [
    layerFlag(s.lan_ok, "LAN"),
    layerFlag(s.wan_ok, "WAN"),
    layerFlag(s.dns_ok, "DNS"),
    layerFlag(s.http_ok, "HTTP"),
  ];
  if (s.gateway) bits.push(`gw ${s.gateway}`);
  const ms =
    s.latency_ms != null && Number.isFinite(Number(s.latency_ms))
      ? Math.round(Number(s.latency_ms))
      : 0;
  bits.push(`${ms} ms`);
  return bits.join(" · ");
}

module.exports = { statusHeadline, layerLatencyLine, layerPills };
