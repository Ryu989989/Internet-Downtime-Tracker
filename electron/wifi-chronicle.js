"use strict";

const DISCONNECT_IDS = new Set([8003, 10001, 11004]);
const CONNECT_IDS = new Set([8001, 8000, 8002, 10000, 11000, 11001, 11005, 107]);
const FAIL_IDS = new Set([11002, 11006]);
const SLEEP_IDS = new Set([42]);
const ROAM_ID = 12013;

const UNKNOWN_EVIDENCE =
  "ISP-up is unproven without router poll or other devices staying online.";

const LABELS = {
  this_pc_wifi: "This PC Wi-Fi",
  isp: "ISP / WAN",
  sleep: "Sleep / resume",
  unknown: "Unknown",
};

function flattenEventData(ed) {
  if (!ed || typeof ed !== "object") return {};
  if (Array.isArray(ed)) {
    const out = {};
    for (const item of ed) {
      if (!item || typeof item !== "object") continue;
      const n = item.Name != null ? item.Name : item.name;
      if (n == null || n === "") continue;
      const v =
        item["#text"] != null
          ? item["#text"]
          : item.Value != null
            ? item.Value
            : item.value != null
              ? item.value
              : item._
                ? item._
                : null;
      out[n] = v;
    }
    return out;
  }
  if (ed.Data != null) return flattenEventData(ed.Data);
  return ed;
}

function pickField(ed, names) {
  const flat = flattenEventData(ed);
  const keys = Object.keys(flat);
  for (const want of names) {
    const wantLc = String(want).toLowerCase();
    for (const k of keys) {
      if (String(k).toLowerCase() === wantLc) {
        const v = flat[k];
        if (v == null) continue;
        const s = String(v).trim();
        if (s !== "") return s;
      }
    }
  }
  return null;
}

function fromMessagePrefix(message, key) {
  if (!message) return null;
  const re = new RegExp(
    `\\b${key}\\s*[:=]\\s*["']?([^"'\\r\\n,;]+)`,
    "i"
  );
  const m = re.exec(String(message));
  return m ? m[1].trim() : null;
}

function normalizeMac(mac) {
  if (mac == null) return null;
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
}

function toUnixSec(time) {
  if (time == null) return null;
  if (typeof time === "number") {
    if (!Number.isFinite(time)) return null;
    return time > 1e12 ? time / 1000 : time;
  }
  if (typeof time === "string") {
    const m = /\/Date\((-?\d+)\)\//.exec(time);
    if (m) return Number(m[1]) / 1000;
    const t = Date.parse(time);
    if (!Number.isNaN(t)) return t / 1000;
  }
  return null;
}

function looksNumeric(s) {
  return s != null && /^-?\d+$/.test(String(s).trim());
}

function classifyKind(id, bssid) {
  const n = Number(id);
  if (SLEEP_IDS.has(n)) return "sleep";
  if (FAIL_IDS.has(n)) return "fail";
  if (DISCONNECT_IDS.has(n)) return "disconnect";
  if (n === ROAM_ID) return bssid ? "roam" : "connect";
  if (CONNECT_IDS.has(n)) return "connect";
  return null;
}

function classifyWlanEvent({ id, eventData, message, time, source } = {}) {
  const msg = message != null ? String(message).replace(/\s+/g, " ").trim() : "";
  const ssid =
    pickField(eventData, ["SSID", "Ssid", "ProfileName", "ConnectionSSID"]) ||
    fromMessagePrefix(msg, "SSID");
  const bssid =
    pickField(eventData, [
      "BSSID",
      "BSSId",
      "BssId",
      "PeerMAC",
      "PeerMac",
      "MacAddress",
      "APMac",
    ]) || fromMessagePrefix(msg, "BSSID");
  const reasonFromData = pickField(eventData, ["Reason", "ReasonText", "ReasonStatus"]);
  const reasonCodeFromData = pickField(eventData, ["ReasonCode", "Reason_Code"]);
  const reasonTextNamed = pickField(eventData, ["ReasonText", "ReasonStatus"]);
  const reason_code =
    reasonCodeFromData ||
    (looksNumeric(reasonFromData) ? reasonFromData : null) ||
    fromMessagePrefix(msg, "ReasonCode");
  const reason_text =
    reasonTextNamed ||
    (!looksNumeric(reasonFromData) ? reasonFromData : null) ||
    (msg ? msg : null) ||
    reasonFromData ||
    fromMessagePrefix(msg, "Reason");
  const kind = classifyKind(id, bssid);
  return {
    kind,
    reason_code: reason_code || null,
    reason_text: reason_text || null,
    ssid: ssid || null,
    bssid: bssid || null,
    event_id: id == null || id === "" ? null : Number(id),
    at: toUnixSec(time),
    source: source != null ? source : null,
  };
}

function detectHostNicRoam(prevSample, nextSample) {
  if (!prevSample || !nextSample) return null;
  const nFrom = normalizeMac(prevSample.bssid);
  const nTo = normalizeMac(nextSample.bssid);
  if (!nFrom || !nTo || nFrom === nTo) return null;
  const ssidPrev =
    prevSample.ssid != null && String(prevSample.ssid).trim() !== ""
      ? String(prevSample.ssid).trim().toLowerCase()
      : null;
  const ssidNext =
    nextSample.ssid != null && String(nextSample.ssid).trim() !== ""
      ? String(nextSample.ssid).trim().toLowerCase()
      : null;
  if (ssidPrev && ssidNext && ssidPrev !== ssidNext) return null;
  return {
    kind: "roam",
    source: "host_nic",
    at: nextSample.at,
    ssid: (nextSample.ssid && String(nextSample.ssid).trim()) || (prevSample.ssid && String(prevSample.ssid).trim()) || null,
    bssid_from: prevSample.bssid,
    bssid_to: nextSample.bssid,
  };
}

function eventsToChronicle(events) {
  const classified = (Array.isArray(events) ? events : [])
    .map((e) => classifyWlanEvent(e || {}))
    .filter((e) => e && e.kind);
  classified.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const out = [];
  for (let i = 0; i < classified.length; i++) {
    const cur = classified[i];
    const next = classified[i + 1];
    const dt = next && cur.at != null && next.at != null ? next.at - cur.at : Infinity;
    if (
      cur.event_id === 8003 &&
      next &&
      next.event_id === 8001 &&
      dt >= 0 &&
      dt <= 15 &&
      cur.bssid &&
      next.bssid &&
      normalizeMac(cur.bssid) &&
      normalizeMac(next.bssid) &&
      normalizeMac(cur.bssid) !== normalizeMac(next.bssid)
    ) {
      out.push({
        kind: "roam",
        reason_code: cur.reason_code,
        reason_text: cur.reason_text,
        ssid: next.ssid || cur.ssid,
        bssid: next.bssid,
        bssid_from: cur.bssid,
        bssid_to: next.bssid,
        event_id: next.event_id,
        at: next.at,
        source: next.source || cur.source,
      });
      i += 1;
      continue;
    }
    out.push(cur);
  }
  return out;
}

function overlapsOutage(event, outage, nowSec) {
  if (!event || !outage) return false;
  const at = Number(event.at);
  const start = Number(outage.started_at);
  if (!Number.isFinite(at) || !Number.isFinite(start)) return false;
  const end =
    outage.ended_at == null || outage.ended_at === ""
      ? nowSec
      : Number(outage.ended_at);
  const endBound = Number.isFinite(end) ? end : nowSec;
  return at >= start && at <= endBound;
}

function verdict(code, evidence) {
  return { code, label: LABELS[code], evidence };
}

function correlateVerdict({
  lanOutage,
  wanOutage,
  wlanEvents,
  routerWanOk,
  peersOnlineDuring,
} = {}) {
  const nowSec = Date.now() / 1000;
  const events = Array.isArray(wlanEvents) ? wlanEvents : [];
  const windows = [lanOutage, wanOutage].filter(Boolean);

  const sleepHit = events.find((e) => {
    if (!e || e.kind !== "sleep") return false;
    if (windows.length === 0) return true;
    return windows.some((o) => overlapsOutage(e, o, nowSec));
  });
  if (sleepHit) {
    return verdict("sleep", [
      `Kernel-Power sleep overlapped the outage (event ${sleepHit.event_id != null ? sleepHit.event_id : 42}).`,
    ]);
  }

  const lanUp = !lanOutage || lanOutage.type !== "lan";
  if ((wanOutage && lanUp) || routerWanOk === false) {
    const evidence = [];
    if (wanOutage && lanUp) evidence.push("WAN outage while LAN was up.");
    if (routerWanOk === false) evidence.push("Router reported WAN down.");
    return verdict("isp", evidence.length ? evidence : ["ISP / WAN indicated by router health."]);
  }

  const lanIsLan = lanOutage && (lanOutage.type == null || lanOutage.type === "lan");
  if (lanIsLan) {
    const wifiish = events.find(
      (e) =>
        e &&
        (e.kind === "disconnect" || e.kind === "roam") &&
        overlapsOutage(e, lanOutage, nowSec)
    );
    if (wifiish && (routerWanOk === true || peersOnlineDuring === true)) {
      return verdict("this_pc_wifi", [
        `WLAN ${wifiish.kind} during LAN outage while router WAN or peers stayed up.`,
      ]);
    }
  }

  return verdict("unknown", [UNKNOWN_EVIDENCE]);
}

module.exports = {
  classifyWlanEvent,
  detectHostNicRoam,
  eventsToChronicle,
  correlateVerdict,
};
