"use strict";

const DEFAULT_MODS = {
  headline: true,
  layers: true,
  metrics: true,
  quality: false,
  streak: false,
  recent: false,
  quiet: false,
  speed: true,
};

const api = typeof window !== "undefined" ? window.idtWidget : null;
let lastAnnounced = "";
let mods = { ...DEFAULT_MODS };
let fillPct = 72;
let lastSnap = null;

function $(id) {
  return document.getElementById(id);
}

function parseMods(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_MODS };
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ...DEFAULT_MODS };
  const out = { ...DEFAULT_MODS };
  for (const k of Object.keys(DEFAULT_MODS)) {
    if (typeof o[k] === "boolean") out[k] = o[k];
  }
  return out;
}

function setFill(pct) {
  const n = Number(pct);
  fillPct = Number.isFinite(n) ? Math.min(92, Math.max(20, n)) : 72;
  const fill = fillPct / 100;
  document.documentElement.style.setProperty("--widget-fill", String(fill));
  const hud = $("hud");
  if (hud) hud.setAttribute("data-scrim", fill < 0.35 ? "1" : "0");
}

function applyMods() {
  document.querySelectorAll("[data-mod]").forEach((el) => {
    const key = el.getAttribute("data-mod");
    const on = mods[key] !== false && (key in mods ? mods[key] : DEFAULT_MODS[key]);
    el.hidden = !on;
  });
}

function layoutMode(w, h) {
  if (w >= 460 && h <= 180) return "wide";
  if (w < 300 || h < 140) return "compact";
  return "standard";
}

function updateLayout() {
  const hud = $("hud");
  if (!hud) return;
  hud.setAttribute("data-layout", layoutMode(window.innerWidth, window.innerHeight));
}

function setPill(el, label, ok) {
  if (!el) return;
  el.textContent = label;
  el.className =
    "pill " + (ok === true ? "pill-ok" : ok === false ? "pill-down" : "pill-unknown");
}

function pillKindClass(kind) {
  if (kind === "ok") return "pill-ok";
  if (kind === "down") return "pill-down";
  if (kind === "amber") return "pill-amber";
  return "pill-unknown";
}

function paintLayerPills(s) {
  const pills = s && s.layer_pills;
  if (!pills) return false;
  const apply = (el, pill) => {
    if (!el || !pill) return;
    el.textContent = pill.text;
    el.className = "pill " + pillKindClass(pill.kind);
  };
  apply($("pillLan"), pills.lan);
  apply($("pillWan"), pills.wan);
  apply($("pillDns"), pills.dns);
  apply($("pillHttp"), pills.http);
  return true;
}

function accentOf(s) {
  if (s.state_color) return s.state_color;
  if (s.paused || s.lan_ok == null) return "gray";
  if (s.lan_ok === false) return "red";
  if (s.wan_ok === false || s.dns_ok === false || s.http_ok === false) return "amber";
  return "green";
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtMbps(n) {
  if (n == null || !Number.isFinite(Number(n))) return "-";
  const v = Number(n);
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

function paintSpeed(s) {
  const el = $("chipSpeed");
  if (!el) return;
  const sp = s.last_speed;
  if (!sp) {
    el.textContent = "No test yet";
    return;
  }
  const down = fmtMbps(sp.download_mbps);
  const up = fmtMbps(sp.upload_mbps);
  const ping =
    sp.ping_ms != null && Number.isFinite(Number(sp.ping_ms))
      ? `${Math.round(Number(sp.ping_ms))} ms`
      : "-";
  const who = sp.isp || sp.server_name || "";
  el.textContent = who ? `↓${down} ↑${up} · ${ping} · ${who}` : `↓${down} ↑${up} · ${ping}`;
}

function syncQuietBadge() {
  const quiet = $("quietBadge");
  if (!quiet) return;
  quiet.hidden = !mods.quiet || !(lastSnap && lastSnap.quiet_hours_active);
}

function applySettings(s) {
  if (!s) return;
  if (s.widget_fill_pct != null) setFill(s.widget_fill_pct);
  if (s.widget_modules_json != null) mods = parseMods(s.widget_modules_json);
  applyMods();
  syncQuietBadge();
}

function paint(s) {
  if (!s) return;
  lastSnap = s;
  if (s.widget_fill_pct != null) setFill(s.widget_fill_pct);
  if (s.widget_modules_json != null) {
    mods = parseMods(s.widget_modules_json);
    applyMods();
  }

  const title = s.status_title != null ? s.status_title : "All clear";
  const sub = s.status_sub != null ? s.status_sub : "LAN, WAN, DNS, and HTTP path OK";
  if ($("title")) $("title").textContent = title;
  if ($("sub")) $("sub").textContent = sub;

  const hud = $("hud");
  if (hud) hud.setAttribute("data-accent", accentOf(s));

  if (!paintLayerPills(s)) {
    setPill($("pillLan"), `LAN ${s.lan_ok === true ? "UP" : s.lan_ok === false ? "DOWN" : "-"}`, s.lan_ok);
    if (s.lan_ok === false) {
      const wan = $("pillWan");
      if (wan) {
        wan.textContent = `WAN ${s.wan_ok === true ? "UP" : "DOWN"}`;
        wan.className = "pill " + (s.wan_ok ? "pill-ok" : "pill-amber");
      }
    } else {
      setPill($("pillWan"), `WAN ${s.wan_ok === true ? "UP" : s.wan_ok === false ? "DOWN" : "-"}`, s.wan_ok);
    }
    if (s.lan_ok !== true || s.wan_ok !== true) {
      setPill($("pillDns"), "DNS -", null);
    } else {
      setPill($("pillDns"), `DNS ${s.dns_ok === true ? "UP" : s.dns_ok === false ? "DOWN" : "-"}`, s.dns_ok);
    }
    if (s.lan_ok !== true || s.wan_ok !== true || s.dns_ok !== true) {
      setPill($("pillHttp"), "HTTP -", null);
    } else {
      setPill($("pillHttp"), `HTTP ${s.http_ok === true ? "UP" : s.http_ok === false ? "DOWN" : "-"}`, s.http_ok);
    }
  }

  if ($("chipLatency")) {
    $("chipLatency").textContent = s.latency_ms != null ? `${Math.round(s.latency_ms)} ms` : "-";
  }
  if ($("chipGw")) $("chipGw").textContent = s.gateway || "-";
  if ($("chipOpen")) $("chipOpen").textContent = String((s.open_outages || []).length);

  const q = s.quality;
  if ($("chipLoss")) $("chipLoss").textContent = q && q.loss_pct != null ? `${q.loss_pct}%` : "-";
  if ($("chipJitter")) $("chipJitter").textContent = q && q.jitter_ms != null ? `${q.jitter_ms} ms` : "-";
  const deg = $("chipDegraded");
  if (deg) deg.hidden = !(s.degraded || (q && q.degraded));

  if ($("chipStreak")) {
    $("chipStreak").textContent = s.in_outage ? "In outage" : fmtDuration((s.uptime_streak_s || 0) * 1000);
  }

  paintSpeed(s);

  const list = $("recentList");
  if (list) {
    const events = Array.isArray(s.recent_events) ? s.recent_events.slice(-3) : [];
    list.replaceChildren(
      ...events.map((ev) => {
        const li = document.createElement("li");
        const t = document.createElement("span");
        t.className = "ev-title";
        t.textContent = ev.title || "";
        li.appendChild(t);
        if (ev.detail) {
          li.appendChild(document.createTextNode(` · ${ev.detail}`));
        }
        return li;
      })
    );
  }

  syncQuietBadge();

  const announcement = `${title}. ${sub}`;
  if (announcement !== lastAnnounced) {
    const live = $("live");
    if (live) live.textContent = announcement;
    lastAnnounced = announcement;
  }
}

function openDash() {
  if (api && typeof api.openDashboard === "function") api.openDashboard();
}

function boot() {
  updateLayout();
  window.addEventListener("resize", updateLayout);
  const btn = $("openDash");
  if (btn) btn.addEventListener("click", openDash);
  const hud = $("hud");
  if (hud) {
    hud.addEventListener("dblclick", (e) => {
      if (e.target.closest(".no-drag")) return;
      openDash();
    });
  }
  if (!api) return;
  if (typeof api.onStatusUpdate === "function") api.onStatusUpdate(paint);
  if (typeof api.onWidgetPrefs === "function") api.onWidgetPrefs(applySettings);
  Promise.resolve()
    .then(async () => {
      if (typeof api.getSettings === "function") {
        applySettings(await api.getSettings());
      }
      if (typeof api.getStatus === "function") paint(await api.getStatus());
    })
    .catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
