/* Internet Downtime Tracker dashboard */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const chartDefaults = {
  color: "#8b9bb0",
  borderColor: "#2c3a4a",
};

Chart.defaults.color = chartDefaults.color;
Chart.defaults.borderColor = chartDefaults.borderColor;
Chart.defaults.font.family = '"Segoe UI", system-ui, sans-serif';

let sparkChart, hourChart, dowChart, latencyChart, speedTrendChart;
let speedRunning = false;

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
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

function fmtTs(ts) {
  if (ts == null) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toLocalInputValue(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToTs(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeOutageType(type) {
  const t = String(type || "").toLowerCase();
  return t === "lan" || t === "wan" || t === "dns" || t === "http" ? t : "lan";
}

/** https-only for href / target=_blank result links. */
function safeHttpsUrl(url) {
  if (url == null || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function fmtMbps(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(1);
}

function fmtMs(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(1)} ms`;
}

async function api(path, opts) {
  if (window.idt) {
    if (path === "/api/status") return window.idt.getStatus();
    if (path === "/api/summary") return window.idt.getSummary();
    if (path === "/api/settings") {
      if (opts && opts.method === "POST") {
        const body = opts.body ? JSON.parse(opts.body) : {};
        return window.idt.updateSettings(body);
      }
      return window.idt.getSettings();
    }
    if (path === "/api/outages/notes") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.updateOutageNotes(body.id, body.notes);
    }
    if (path.startsWith("/api/outages")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("from")) params.from = q.get("from");
      if (q.get("to")) params.to = q.get("to");
      if (q.get("type")) params.type = q.get("type");
      if (q.get("min_ms")) params.min_ms = q.get("min_ms");
      if (q.get("sort")) params.sort = q.get("sort");
      if (q.get("dir")) params.dir = q.get("dir");
      if (q.get("limit")) params.limit = q.get("limit");
      return window.idt.getOutages(params);
    }
    if (path.startsWith("/api/system-logs")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("from")) params.from = q.get("from");
      if (q.get("to")) params.to = q.get("to");
      if (q.get("min_ms")) params.min_ms = q.get("min_ms");
      if (q.get("limit")) params.limit = q.get("limit");
      if (path.startsWith("/api/system-logs/scan") || q.get("refresh") === "1") {
        return window.idt.scanSystemLogs(params);
      }
      return window.idt.getSystemLogs(params);
    }
    if (path === "/api/speedtest/status") return window.idt.speedtestStatus();
    if (path.startsWith("/api/speedtest/history")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("limit")) params.limit = q.get("limit");
      return window.idt.speedtestHistory(params);
    }
    if (path === "/api/speedtest/run") return window.idt.speedtestRun();
    if (path === "/api/speedtest/cancel") return window.idt.speedtestCancel();
    if (path === "/api/speedtest/install") return window.idt.speedtestInstall();
    if (path === "/api/monitor/pause") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.setPaused(!!body.paused);
    }
    if (path === "/api/export/outages") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.exportOutages(body);
    }
    if (path === "/api/export/report") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.exportReport(body);
    }
    throw new Error(`unknown api ${path}`);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function setPill(el, label, ok) {
  el.textContent = label;
  el.className = "pill " + (ok === true ? "pill-ok" : ok === false ? "pill-down" : "pill-unknown");
}

function activateTab(tab) {
  const btn = $(`.tab[data-tab="${tab}"]`);
  if (!btn) return;
  $$(".tab").forEach((b) => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  $$(".panel").forEach((p) => {
    const active = p.id === `panel-${tab}`;
    p.classList.toggle("active", active);
    p.hidden = !active;
  });
  if (tab === "patterns") {
    refreshSummary();
    refreshLongest();
  }
  if (tab === "history") {
    refreshHistoryToNow();
    refreshHistory();
  }
  if (tab === "system-logs") refreshSystemLogs({ refresh: false });
  if (tab === "speed") refreshSpeed();
  if (tab === "settings") loadSettings().catch(() => {});
  if (tab === "overview") {
    refreshStatus();
    refreshSummary();
  }
}

function chartBarPlugins(unitSingular, unitPlural) {
  return {
    legend: { display: false },
    tooltip: {
      enabled: true,
      callbacks: {
        label(ctx) {
          const v = ctx.parsed.y;
          if (v == null) return " No data";
          const n = Number(v);
          const unit = n === 1 ? unitSingular : unitPlural;
          return ` ${n} ${unit}`;
        },
      },
    },
  };
}

function setupTabs() {
  const tabs = $$(".tab");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
  const tablist = $(".tabs");
  if (!tablist) return;
  tablist.addEventListener("keydown", (e) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    tabs[next].focus();
    activateTab(tabs[next].dataset.tab);
  });
}

function chartScaleOpts() {
  return {
    x: { grid: { color: "rgba(44, 58, 74, 0.55)" }, ticks: { maxRotation: 0 } },
    y: { beginAtZero: true, grid: { color: "rgba(44, 58, 74, 0.45)" } },
  };
}

function ensureSpark(data) {
  const ctx = $("#sparkChart");
  if (!ctx) return;
  const labels = data.map((_, i) => {
    const h = new Date(Date.now() - (23 - i) * 3600_000).getHours();
    return `${h}:00`;
  });
  const values = data.map((s) => Math.round(s));
  if (sparkChart) {
    sparkChart.data.labels = labels;
    sparkChart.data.datasets[0].data = values;
    sparkChart.update("none");
    return;
  }
  sparkChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Downtime (s)",
        data: values,
        backgroundColor: "rgba(240, 113, 120, 0.55)",
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: chartBarPlugins("second downtime", "seconds downtime"),
      scales: {
        ...chartScaleOpts(),
        y: { ...chartScaleOpts().y, ticks: { callback: (v) => `${v}s` } },
      },
    },
  });
}

function ensureLatency(data) {
  const ctx = $("#latencyChart");
  const empty = $("#latencyEmpty");
  if (!ctx) return;
  const has = (data || []).some((v) => v != null);
  if (empty) empty.hidden = has;
  const labels = (data || []).map((_, i) => {
    const mins = Math.round((i / Math.max(1, data.length - 1)) * 360);
    return `${Math.floor(mins / 60)}h`;
  });
  const values = (data || []).map((v) => (v == null ? null : v));
  if (latencyChart) {
    latencyChart.data.labels = labels;
    latencyChart.data.datasets[0].data = values;
    latencyChart.update("none");
    return;
  }
  latencyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "ms",
        data: values,
        borderColor: "rgba(91, 159, 212, 0.9)",
        backgroundColor: "rgba(91, 159, 212, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              if (v == null) return " No sample";
              return ` ${v} ms`;
            },
          },
        },
      },
      scales: {
        ...chartScaleOpts(),
        y: { ...chartScaleOpts().y, ticks: { callback: (v) => `${v}` } },
      },
    },
  });
}

function ensureHour(data) {
  const ctx = $("#hourChart");
  if (!ctx) return;
  const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  if (hourChart) {
    hourChart.data.datasets[0].data = data;
    hourChart.update("none");
    return;
  }
  hourChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Outage starts",
        data,
        backgroundColor: "rgba(91, 159, 212, 0.6)",
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: chartBarPlugins("outage start", "outage starts"),
      scales: {
        ...chartScaleOpts(),
        y: { ...chartScaleOpts().y, ticks: { stepSize: 1 } },
      },
    },
  });
}

function ensureDow(data) {
  const ctx = $("#dowChart");
  if (!ctx) return;
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (dowChart) {
    dowChart.data.datasets[0].data = data;
    dowChart.update("none");
    return;
  }
  dowChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Outage starts",
        data,
        backgroundColor: "rgba(230, 180, 80, 0.55)",
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: chartBarPlugins("outage start", "outage starts"),
      scales: chartScaleOpts(),
    },
  });
}

function ensureSpeedTrend(tests) {
  const ctx = $("#speedTrendChart");
  const empty = $("#speedTrendEmpty");
  if (!ctx) return;
  const rows = [...(tests || [])].reverse();
  const has = rows.length > 0;
  if (empty) empty.hidden = has;
  const labels = rows.map((t) => {
    const d = new Date(t.tested_at * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const down = rows.map((t) => t.download_mbps);
  const up = rows.map((t) => t.upload_mbps);
  if (speedTrendChart) {
    speedTrendChart.data.labels = labels;
    speedTrendChart.data.datasets[0].data = down;
    speedTrendChart.data.datasets[1].data = up;
    speedTrendChart.update("none");
    return;
  }
  speedTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Down",
          data: down,
          borderColor: "rgba(62, 207, 142, 0.9)",
          backgroundColor: "transparent",
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: "Up",
          data: up,
          borderColor: "rgba(91, 159, 212, 0.9)",
          backgroundColor: "transparent",
          tension: 0.3,
          pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { labels: { boxWidth: 10 } } },
      scales: {
        ...chartScaleOpts(),
        y: { ...chartScaleOpts().y, ticks: { callback: (v) => `${v}` } },
      },
    },
  });
}

function renderOutageRows(tbody, rows, { showEnded = true, editableNotes = false, emptyMsg = "No outages" } = {}) {
  const now = Date.now() / 1000;
  const cols = showEnded ? 5 : 4;
  tbody.innerHTML = rows.map((o) => {
    const open = o.ended_at == null;
    const dur = o.duration_ms != null ? o.duration_ms : Math.floor((now - o.started_at) * 1000);
    const typ = safeOutageType(o.type);
    const notesCell = editableNotes
      ? `<td class="notes-cell">
          <input type="text" class="notes-input" data-outage-id="${Number(o.id)}"
            value="${escapeHtml(o.notes || "")}" maxlength="2000" placeholder="Add note…"
            aria-label="Outage note" />
        </td>`
      : `<td>${o.notes ? escapeHtml(o.notes) : ""}</td>`;
    return `<tr class="${open ? "open-row" : ""}">
      <td class="type-${typ}">${escapeHtml(typ.toUpperCase())}</td>
      <td>${fmtTs(o.started_at)}</td>
      ${showEnded ? `<td>${open ? "ongoing" : fmtTs(o.ended_at)}</td>` : ""}
      <td class="dur">${fmtDuration(dur)}${open ? "…" : ""}</td>
      ${notesCell}
    </tr>`;
  }).join("") || `<tr><td colspan="${cols}" class="muted">${escapeHtml(emptyMsg)}</td></tr>`;

  if (editableNotes) {
    tbody.querySelectorAll(".notes-input").forEach((input) => {
      let last = input.value;
      const save = async () => {
        if (input.value === last) return;
        const id = Number(input.dataset.outageId);
        if (!Number.isFinite(id) || id <= 0) return;
        try {
          await api("/api/outages/notes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, notes: input.value }),
          });
          last = input.value;
          input.classList.remove("error");
          input.classList.add("saved");
          setTimeout(() => input.classList.remove("saved"), 800);
        } catch (err) {
          console.error(err);
          input.classList.add("error");
          setTimeout(() => input.classList.remove("error"), 1200);
        }
      };
      input.addEventListener("change", save);
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        }
      });
    });
  }
}

function timelineTooltip(o, { now = Date.now() / 1000 } = {}) {
  const typ = safeOutageType(o.type).toUpperCase();
  const open = o.ended_at == null;
  const end = open ? now : o.ended_at;
  const durMs = o.duration_ms != null
    ? o.duration_ms
    : Math.floor((end - o.started_at) * 1000);
  const range = `${fmtTs(o.started_at)} → ${open ? "ongoing" : fmtTs(o.ended_at)}`;
  let tip = `${typ} · ${range} · ${fmtDuration(durMs)}${open ? "…" : ""}`;
  if (o.count != null && Number(o.count) > 1) tip += ` · ${o.count} events`;
  return tip;
}

function renderSplit(el, win) {
  if (!el || !win) return;
  const parts = ["lan", "wan", "dns", "http"].map((k) => {
    const w = win[k] || {};
    if (!(w.count || w.downtime_ms)) return "";
    return `<span class="split-pill ${k}">${k.toUpperCase()} ${fmtDuration(w.downtime_ms)} · ${w.count || 0}</span>`;
  }).filter(Boolean);
  el.innerHTML = parts.join("") || `<span class="split-pill">No events</span>`;
}

function renderTimeline(el, events, { now = Date.now() / 1000 } = {}) {
  if (!el) return;
  const start = now - 86400;
  const span = 86400;
  const rows = events || [];
  if (!rows.length) {
    el.innerHTML = `<div class="timeline-empty muted" title="No outages">No outages in the last 24 hours</div>`;
    return;
  }
  const blocks = rows.map((o) => {
    const typ = safeOutageType(o.type);
    const oStart = Math.max(o.started_at, start);
    const oEnd = Math.min(o.ended_at != null ? o.ended_at : now, now);
    if (oEnd <= oStart) return "";
    const left = ((oStart - start) / span) * 100;
    const width = Math.max(0.35, ((oEnd - oStart) / span) * 100);
    const tip = timelineTooltip(o, { now });
    return `<div class="tl-block ${typ}" style="left:${left}%;width:${width}%"
      tabindex="0" role="img" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></div>`;
  }).join("");
  el.innerHTML = `<div class="timeline-track" title="Colored blocks are outages; empty track = up">${blocks}</div>
    <div class="timeline-axis"><span>−24h</span><span>−12h</span><span>now</span></div>`;
}

function paintProvider(provider) {
  const strip = $("#providerStrip");
  if (!strip) return;
  const has =
    provider &&
    (provider.isp || provider.server_name || provider.server_location || provider.ping_ms != null);
  strip.classList.toggle("is-empty", !has);
  const empty = $("#providerEmpty");
  if (empty) empty.hidden = !!has;
  if (!has) {
    if ($("#providerIsp")) $("#providerIsp").textContent = "—";
    if ($("#providerServer")) $("#providerServer").textContent = "";
    if ($("#providerPingChip")) $("#providerPingChip").hidden = true;
    if ($("#providerWhenChip")) $("#providerWhenChip").hidden = true;
    return;
  }
  $("#providerIsp").textContent = provider.isp || "Unknown ISP";
  const area = [provider.server_name, provider.server_location].filter(Boolean).join(" · ");
  $("#providerServer").textContent = area
    ? `Closest server · ${area}`
    : "Closest server · unknown";
  const pingChip = $("#providerPingChip");
  if (pingChip) {
    const showPing = provider.ping_ms != null;
    pingChip.hidden = !showPing;
    if (showPing) $("#providerPing").textContent = `${Number(provider.ping_ms).toFixed(1)} ms`;
  }
  const whenChip = $("#providerWhenChip");
  if (whenChip) {
    const showWhen = provider.tested_at != null;
    whenChip.hidden = !showWhen;
    if (showWhen) $("#providerWhen").textContent = fmtTs(provider.tested_at);
  }
}

function paintStatus(s) {
  if (!s) return;
  setPill($("#pillLan"), `LAN ${s.lan_ok === true ? "UP" : s.lan_ok === false ? "DOWN" : "—"}`, s.lan_ok);
  if (s.lan_ok === false) {
    $("#pillWan").textContent = `WAN ${s.wan_ok === true ? "UP" : "DOWN"}`;
    $("#pillWan").className = "pill " + (s.wan_ok ? "pill-ok" : "pill-amber");
  } else {
    setPill($("#pillWan"), `WAN ${s.wan_ok === true ? "UP" : s.wan_ok === false ? "DOWN" : "—"}`, s.wan_ok);
  }
  if ($("#pillDns")) {
    if (s.lan_ok !== true || s.wan_ok !== true) {
      $("#pillDns").textContent = "DNS —";
      $("#pillDns").className = "pill pill-unknown";
    } else {
      setPill($("#pillDns"), `DNS ${s.dns_ok === true ? "UP" : s.dns_ok === false ? "DOWN" : "—"}`, s.dns_ok);
    }
  }
  if ($("#pillHttp")) {
    if (s.lan_ok !== true || s.wan_ok !== true || s.dns_ok !== true) {
      $("#pillHttp").textContent = "HTTP —";
      $("#pillHttp").className = "pill pill-unknown";
    } else {
      setPill($("#pillHttp"), `HTTP ${s.http_ok === true ? "UP" : s.http_ok === false ? "DOWN" : "—"}`, s.http_ok);
    }
  }
  const bits = [];
  if (s.gateway) bits.push(`gw ${s.gateway}`);
  if (s.latency_ms != null) bits.push(`${Math.round(s.latency_ms)} ms`);
  if (s.paused) bits.push("PAUSED");
  else if (s.probe_suppressed) bits.push("SPEEDTEST");
  if (s.failure_domain) bits.push(String(s.failure_domain).toUpperCase());
  if (s.lan_method) bits.push(s.lan_method);
  $("#metaLine").textContent = bits.join(" · ");
  $("#openCount").textContent = String((s.open_outages || []).length);
  if ($("#heroGateway")) $("#heroGateway").textContent = s.gateway || "—";
  if ($("#heroLatency")) {
    $("#heroLatency").textContent = s.latency_ms != null ? `${Math.round(s.latency_ms)} ms` : "—";
  }

  const adapterEl = $("#adapterLine");
  if (adapterEl) {
    const a = s.adapter;
    if (a && a.name) {
      const kind = a.type === "wifi" ? "Wi‑Fi" : a.type === "ethernet" ? "Ethernet" : "Adapter";
      const sig = a.type === "wifi" && a.signal != null ? ` · ${a.signal}%` : "";
      adapterEl.textContent = `${kind} · ${a.name}${sig}`;
      adapterEl.hidden = false;
    } else {
      adapterEl.hidden = true;
    }
  }

  let title = "All clear";
  let sub = "LAN, WAN, DNS, and HTTP path OK";
  if (s.paused) {
    title = "Paused";
    sub = "Monitoring is paused — resume from Settings or the tray";
  } else if (s.probe_suppressed) {
    title = "Speed test running";
    sub = "Probes paused so the test won’t pollute History";
  } else if (s.lan_ok === false) {
    title = "LAN down";
    sub = "Gateway unreachable — local network issue likely";
  } else if (s.wan_ok === false) {
    title = "WAN down";
    sub = "LAN up, public internet unreachable";
  } else if (s.dns_ok === false) {
    title = "DNS down";
    sub = "TCP path up, DNS resolution failing";
  } else if (s.http_ok === false) {
    title = "HTTP path down";
    sub = "DNS OK, web connectivity check failing (captive portal?)";
  } else if (s.lan_ok == null || s.wan_ok == null) {
    title = "Warming up";
    sub = "Waiting for first probe results";
  }
  if ($("#statusTitle")) $("#statusTitle").textContent = title;
  if ($("#statusSub")) $("#statusSub").textContent = sub;

  const pausedBox = $("#settingsPaused");
  if (pausedBox && document.activeElement !== pausedBox) {
    pausedBox.checked = !!s.paused;
  }

  if ($("#uptimeStreak") && (s.in_outage != null || s.uptime_streak_s != null)) {
    $("#uptimeStreak").textContent = s.in_outage
      ? "In outage"
      : fmtDuration((s.uptime_streak_s || 0) * 1000);
    if ($("#uptimeSub")) {
      $("#uptimeSub").textContent = s.in_outage ? "Recovery pending" : "Since last recovery";
    }
  }

  const logo = $(".logo");
  if (logo) {
    // Color is decorative; text status lives in pills + statusTitle (not color-only).
    logo.setAttribute("aria-label", `Status: ${title}`);
    logo.setAttribute("title", title);
    if (s.probe_suppressed) {
      logo.style.background = "var(--blue)";
      logo.style.boxShadow = "0 0 0 3px rgba(91,159,212,0.3)";
    } else if (s.lan_ok === false) {
      logo.style.background = "var(--red)";
      logo.style.boxShadow = "0 0 0 3px rgba(240,113,120,0.3)";
    } else if (s.wan_ok === false || s.dns_ok === false || s.http_ok === false) {
      logo.style.background = "var(--amber)";
      logo.style.boxShadow = "0 0 0 3px rgba(230,180,80,0.3)";
    } else if (s.lan_ok && s.wan_ok && s.dns_ok !== false && s.http_ok !== false) {
      logo.style.background = "var(--green)";
      logo.style.boxShadow = "0 0 0 3px rgba(62,207,142,0.25)";
    }
  }
}

async function refreshStatus() {
  try {
    paintStatus(await api("/api/status"));
  } catch (e) {
    $("#metaLine").textContent = "status unavailable";
    if ($("#statusTitle")) $("#statusTitle").textContent = "Status unavailable";
  }
}

async function refreshSummary() {
  try {
    const sum = await api("/api/summary");
    $("#uptimeStreak").textContent = sum.in_outage
      ? "In outage"
      : fmtDuration(sum.uptime_streak_s * 1000);
    if ($("#uptimeSub")) {
      $("#uptimeSub").textContent = sum.in_outage ? "Recovery pending" : "Since last recovery";
    }
    const w24 = sum.windows["24h"].all;
    const w7 = sum.windows["7d"].all;
    $("#down24").textContent = fmtDuration(w24.downtime_ms);
    $("#down24pct").textContent = `${w24.downtime_pct}% · ${w24.count} events`;
    $("#down7").textContent = fmtDuration(w7.downtime_ms);
    $("#down7pct").textContent = `${w7.downtime_pct}% · ${w7.count} events`;
    renderSplit($("#split24"), sum.windows["24h"]);
    renderSplit($("#split7"), sum.windows["7d"]);
    if ($("#events7")) {
      $("#events7").textContent = String(w7.count);
      const w = sum.windows["7d"];
      const bits = ["lan", "wan", "dns", "http"]
        .map((k) => `${w[k]?.count || 0} ${k.toUpperCase()}`)
        .join(" · ");
      $("#events7sub").textContent = bits;
    }
    renderTimeline($("#timeline24"), sum.timeline_24h || []);
    if ($("#timelineMeta")) {
      $("#timelineMeta").textContent = `${(sum.timeline_24h || []).length} events`;
    }
    ensureSpark(sum.sparkline_24h || []);
    ensureLatency(sum.latency_spark_6h || []);
    ensureHour(sum.by_hour || []);
    ensureDow(sum.by_dow || []);
    if ($("#recentBody")) {
      renderOutageRows($("#recentBody"), sum.recent_outages || [], { showEnded: false });
      if ($("#recentMeta")) {
        $("#recentMeta").textContent = `${(sum.recent_outages || []).length} latest`;
      }
    }
    paintProvider(sum.provider);
  } catch (e) {
    console.error(e);
  }
}

function refreshHistoryToNow() {
  const form = $("#historyFilters");
  if (!form || !form.to) return;
  form.to.value = toLocalInputValue(Date.now() / 1000);
}

async function refreshHistory() {
  const form = $("#historyFilters");
  const meta = $("#historyMeta");
  const fd = new FormData(form);
  const params = new URLSearchParams();
  const from = localInputToTs(fd.get("from"));
  const to = localInputToTs(fd.get("to"));
  if (from != null) params.set("from", String(from));
  if (to != null) params.set("to", String(to));
  const type = fd.get("type");
  if (type && type !== "all") params.set("type", type);
  const minS = fd.get("min_s");
  if (minS) params.set("min_ms", String(Number(minS) * 1000));
  params.set("sort", fd.get("sort") || "started_at");
  params.set("dir", fd.get("dir") || "DESC");
  if (meta) meta.textContent = "Loading…";
  try {
    const data = await api(`/api/outages?${params}`);
    const rows = data.outages || [];
    renderOutageRows($("#outageBody"), rows, {
      editableNotes: true,
      emptyMsg: "No outages in this range — try widening From/To or clearing filters",
    });
    if (meta) meta.textContent = `${rows.length} outage${rows.length === 1 ? "" : "s"}`;
  } catch (e) {
    console.error(e);
    $("#outageBody").innerHTML = `<tr><td colspan="5" class="muted state-error">Failed to load history</td></tr>`;
    if (meta) meta.textContent = "Load failed";
  }
}

async function refreshLongest() {
  const form = $("#patternsFilters");
  const tbody = $("#longestBody");
  if (!tbody) return;
  const now = Date.now() / 1000;
  const params = new URLSearchParams();
  params.set("from", String(now - 30 * 86400));
  params.set("to", String(now));
  params.set("limit", "50");
  if (form) {
    const fd = new FormData(form);
    const type = fd.get("type");
    if (type && type !== "all") params.set("type", type);
    params.set("sort", fd.get("sort") || "duration");
    params.set("dir", fd.get("dir") || "DESC");
  } else {
    params.set("sort", "duration");
    params.set("dir", "DESC");
  }
  try {
    const data = await api(`/api/outages?${params}`);
    const rows = data.outages || [];
    renderOutageRows(tbody, rows, {
      showEnded: false,
      editableNotes: true,
      emptyMsg: "No outages in the last 30 days for this filter",
    });
    if ($("#longestMeta")) {
      $("#longestMeta").textContent = `${rows.length} shown`;
    }
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="4" class="muted state-error">Failed to load</td></tr>`;
  }
}

function renderSystemLogRows(tbody, rows) {
  tbody.innerHTML = (rows || []).map((g) => {
    const open = g.ended_at == null;
    const dur = g.duration_ms != null
      ? g.duration_ms
      : Math.floor((Date.now() / 1000 - g.started_at) * 1000);
    return `<tr class="${open ? "open-row" : ""}">
      <td>${fmtTs(g.started_at)}</td>
      <td>${open ? "ongoing" : fmtTs(g.ended_at)}</td>
      <td class="dur">${fmtDuration(dur)}${open ? "…" : ""}</td>
      <td>${escapeHtml(g.source || "")}</td>
      <td>${g.reason ? escapeHtml(g.reason) : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">No OS-logged gaps in this range</td></tr>`;
}

async function refreshSystemLogs({ refresh = false } = {}) {
  const form = $("#systemLogsFilters");
  if (!form) return;
  const fd = new FormData(form);
  const params = new URLSearchParams();
  const from = localInputToTs(fd.get("from"));
  const to = localInputToTs(fd.get("to"));
  if (from != null) params.set("from", String(from));
  if (to != null) params.set("to", String(to));
  const minS = fd.get("min_s");
  if (minS) params.set("min_ms", String(Number(minS) * 1000));
  const meta = $("#systemLogsMeta");
  const applyBtn = $("#systemLogsApply");
  const refreshBtn = $("#systemLogsRefresh");
  meta.textContent = refresh ? "Scanning Windows logs…" : "Loading…";
  if (applyBtn) applyBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const path = refresh
      ? `/api/system-logs/scan?${params}`
      : `/api/system-logs?${params}`;
    const data = await api(path);
    renderSystemLogRows($("#systemLogsBody"), data.gaps || []);
    const bits = [`${data.count || 0} gaps`];
    if (data.event_count != null) bits.push(`${data.event_count} events`);
    if (data.cached) bits.push("cached");
    if (data.scanned_at) bits.push(`scanned ${fmtTs(data.scanned_at)}`);
    meta.textContent = bits.join(" · ");
    if (data.warnings && data.warnings.length) {
      meta.textContent += ` · ${data.warnings[0]}`;
    }
  } catch (e) {
    console.error(e);
    $("#systemLogsBody").innerHTML =
      `<tr><td colspan="5" class="muted state-error">Scan failed: ${escapeHtml(e.message || e)}</td></tr>`;
    meta.textContent = "Scan failed";
  } finally {
    if (applyBtn) applyBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function paintSpeedLast(test) {
  if (!test) {
    $("#speedDown").textContent = "—";
    $("#speedUp").textContent = "—";
    $("#speedPing").textContent = "—";
    $("#speedJitter").textContent = "jitter —";
    $("#speedLoss").textContent = "—";
    $("#speedIsp").textContent = "";
    return;
  }
  $("#speedDown").textContent = fmtMbps(test.download_mbps);
  $("#speedUp").textContent = fmtMbps(test.upload_mbps);
  $("#speedPing").textContent = test.ping_ms != null ? Number(test.ping_ms).toFixed(1) : "—";
  $("#speedJitter").textContent = test.jitter_ms != null ? `jitter ${Number(test.jitter_ms).toFixed(1)} ms` : "jitter —";
  $("#speedLoss").textContent = test.packet_loss != null ? `${Number(test.packet_loss).toFixed(2)}%` : "—";
  const bits = [];
  if (test.isp) bits.push(test.isp);
  if (test.server_name) bits.push(test.server_name);
  $("#speedIsp").textContent = bits.join(" · ");
}

function renderSpeedHistory(rows) {
  const tbody = $("#speedHistoryBody");
  tbody.innerHTML = (rows || []).map((t) => {
    const safeUrl = safeHttpsUrl(t.result_url);
    const link = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer noopener">result</a>`
      : "";
    const server = [t.server_name, t.server_location].filter(Boolean).join(" · ");
    return `<tr>
      <td>${fmtTs(t.tested_at)}</td>
      <td>${fmtMbps(t.download_mbps)}</td>
      <td>${fmtMbps(t.upload_mbps)}</td>
      <td>${t.ping_ms != null ? Number(t.ping_ms).toFixed(1) : "—"}</td>
      <td>${t.jitter_ms != null ? Number(t.jitter_ms).toFixed(1) : "—"}</td>
      <td>${t.packet_loss != null ? Number(t.packet_loss).toFixed(2) + "%" : "—"}</td>
      <td>${escapeHtml(server)}</td>
      <td>${link}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">No speed tests yet</td></tr>`;
}

async function refreshSpeed() {
  const statusEl = $("#speedStatus");
  try {
    const [st, hist] = await Promise.all([
      api("/api/speedtest/status"),
      api("/api/speedtest/history?limit=50"),
    ]);
    paintSpeedLast(hist.latest);
    renderSpeedHistory(hist.tests || []);
    ensureSpeedTrend(hist.tests || []);
    if (!speedRunning) {
      if (st.available) {
        statusEl.textContent = `CLI ready${st.path ? ` · ${st.path}` : ""}`;
        statusEl.className = "muted state-ok";
      } else {
        statusEl.textContent = st.install_hint || "Speedtest CLI not found";
        statusEl.className = "muted";
      }
    }
    $("#speedRunBtn").disabled = speedRunning || !st.available;
    $("#speedInstallBtn").hidden = !!st.available;
  } catch (e) {
    statusEl.textContent = e.message || "Failed to load speed data";
    statusEl.className = "muted state-error";
  }
}

async function runSpeedTest() {
  if (speedRunning) return;
  speedRunning = true;
  const statusEl = $("#speedStatus");
  const runBtn = $("#speedRunBtn");
  const cancelBtn = $("#speedCancelBtn");
  runBtn.disabled = true;
  cancelBtn.hidden = false;
  statusEl.textContent = "Running Ookla Speedtest… this can take ~20–60s";
  statusEl.className = "muted";
  try {
    const data = await api("/api/speedtest/run");
    paintSpeedLast(data.test);
    statusEl.textContent = "Test complete";
    statusEl.className = "muted state-ok";
    await refreshSpeed();
    paintProvider(
      data.test
        ? {
            isp: data.test.isp,
            server_name: data.test.server_name,
            server_location: data.test.server_location,
            ping_ms: data.test.ping_ms,
            tested_at: data.test.tested_at,
          }
        : null
    );
  } catch (e) {
    statusEl.textContent = e.message || "Speed test failed";
    statusEl.className = "muted state-error";
    await refreshSpeed();
  } finally {
    speedRunning = false;
    cancelBtn.hidden = true;
    runBtn.disabled = false;
  }
}

async function loadSettings() {
  const form = $("#settingsForm");
  if (!form) return;
  const s = await api("/api/settings");
  form.poll_interval_s.value = s.poll_interval_s;
  form.debounce_fail_count.value = s.debounce_fail_count;
  form.probe_retention_days.value = s.probe_retention_days ?? 14;
  form.autostart.checked = !!s.autostart;
  form.toast_alerts.checked = !!s.toast_alerts;
  if (form.minimize_to_tray) {
    form.minimize_to_tray.checked = s.minimize_to_tray !== false;
  }
  form.wan_targets.value = s.wan_targets || "";
  form.dns_resolver.value = s.dns_resolver || "";
  form.http_url.value = s.http_url || "";
  try {
    const st = await api("/api/status");
    if (form.paused) form.paused.checked = !!st.paused;
  } catch {
    /* ignore */
  }
}

function setupForms() {
  $("#historyFilters").addEventListener("submit", (e) => {
    e.preventDefault();
    refreshHistory();
  });
  const histReset = $("#historyReset");
  if (histReset) {
    histReset.addEventListener("click", () => {
      defaultHistoryRange();
      refreshHistory();
    });
  }
  const patterns = $("#patternsFilters");
  if (patterns) {
    patterns.addEventListener("submit", (e) => {
      e.preventDefault();
      refreshLongest();
    });
  }
  const slog = $("#systemLogsFilters");
  if (slog) {
    slog.addEventListener("submit", (e) => {
      e.preventDefault();
      refreshSystemLogs({ refresh: false });
    });
  }
  const slogRefresh = $("#systemLogsRefresh");
  if (slogRefresh) {
    slogRefresh.addEventListener("click", () => refreshSystemLogs({ refresh: true }));
  }
  const runBtn = $("#speedRunBtn");
  if (runBtn) runBtn.addEventListener("click", () => runSpeedTest());
  const cancelBtn = $("#speedCancelBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      try {
        await api("/api/speedtest/cancel");
        $("#speedStatus").textContent = "Cancelled";
      } catch (_) { /* ignore */ }
    });
  }
  const installBtn = $("#speedInstallBtn");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      $("#speedStatus").textContent = "Downloading official Ookla CLI…";
      try {
        await api("/api/speedtest/install");
        $("#speedStatus").textContent = "CLI installed";
        $("#speedStatus").className = "muted state-ok";
        await refreshSpeed();
      } catch (e) {
        $("#speedStatus").textContent = e.message || "Install failed";
        $("#speedStatus").className = "muted state-error";
      } finally {
        installBtn.disabled = false;
      }
    });
  }
  const csvBtn = $("#exportCsvBtn");
  if (csvBtn) {
    csvBtn.addEventListener("click", async () => {
      const msg = $("#evidenceMsg");
      try {
        const res = await api("/api/export/outages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (msg) msg.textContent = res.path ? `Saved ${res.path}` : "Exported";
      } catch (err) {
        if (msg) msg.textContent = "CSV export failed";
      }
    });
  }
  const reportBtn = $("#exportReportBtn");
  if (reportBtn) {
    reportBtn.addEventListener("click", async () => {
      const msg = $("#evidenceMsg");
      try {
        const res = await api("/api/export/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (msg) msg.textContent = res.path ? "Report opened" : "Report ready";
      } catch (err) {
        if (msg) msg.textContent = "Report failed";
      }
    });
  }
  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      poll_interval_s: Number(form.poll_interval_s.value),
      debounce_fail_count: Number(form.debounce_fail_count.value),
      probe_retention_days: Number(form.probe_retention_days.value),
      autostart: form.autostart.checked,
      toast_alerts: form.toast_alerts.checked,
      minimize_to_tray: form.minimize_to_tray
        ? form.minimize_to_tray.checked
        : true,
      wan_targets: form.wan_targets.value.trim(),
      dns_resolver: form.dns_resolver.value.trim(),
      http_url: form.http_url.value.trim(),
    };
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await api("/api/monitor/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !!form.paused.checked }),
      });
      $("#settingsMsg").textContent = "Saved";
      setTimeout(() => { $("#settingsMsg").textContent = ""; }, 2000);
      refreshStatus();
    } catch (err) {
      $("#settingsMsg").textContent = "Save failed";
    }
  });
}

function defaultHistoryRange() {
  const form = $("#historyFilters");
  const now = Date.now() / 1000;
  form.from.value = toLocalInputValue(now - 7 * 86400);
  form.to.value = toLocalInputValue(now);
}

function defaultSystemLogsRange() {
  const form = $("#systemLogsFilters");
  if (!form) return;
  const now = Date.now() / 1000;
  form.from.value = toLocalInputValue(now - 7 * 86400);
  form.to.value = toLocalInputValue(now);
}

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupForms();
  defaultHistoryRange();
  defaultSystemLogsRange();
  document.querySelectorAll("[data-goto-tab]").forEach((el) => {
    el.addEventListener("click", () => activateTab(el.getAttribute("data-goto-tab")));
  });
  if (window.idt && typeof window.idt.onStatusUpdate === "function") {
    window.idt.onStatusUpdate((s) => paintStatus(s));
  }
  try {
    await loadSettings();
  } catch (_) { /* ignore */ }
  await refreshStatus();
  await refreshSummary();
  await refreshHistory();
  // Event-driven status is primary; ~1s fallback keeps streak/latency feeling live.
  setInterval(refreshStatus, 1000);
  setInterval(refreshSummary, 8000);
});
