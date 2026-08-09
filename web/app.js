/* Internet Downtime Tracker dashboard */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const cssVar = (name, fallback) => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
};

const chartTheme = {
  color: () => cssVar("--muted", "#9aabba"),
  border: () => cssVar("--border", "#2c3a4a"),
  grid: "rgba(44, 58, 74, 0.5)",
  tooltipBg: cssVar("--tooltip-bg", "#101923"),
  tooltipBorder: cssVar("--border", "#2c3a4a"),
  domain: {
    lan: "rgba(240, 113, 120, 0.55)",
    wan: "rgba(230, 180, 80, 0.55)",
    dns: "rgba(91, 159, 212, 0.6)",
    http: "rgba(62, 207, 142, 0.55)",
    latency: "rgba(91, 159, 212, 0.9)",
    down: "rgba(62, 207, 142, 0.9)",
    up: "rgba(91, 159, 212, 0.9)",
  },
};

function applyChartDefaults() {
  Chart.defaults.color = chartTheme.color();
  Chart.defaults.borderColor = chartTheme.border();
  Chart.defaults.font.family = '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
  Chart.defaults.devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
  Chart.defaults.animation = false;
  Chart.defaults.transitions = { active: { animation: { duration: 0 } } };
  Chart.defaults.plugins.tooltip.backgroundColor = chartTheme.tooltipBg;
  Chart.defaults.plugins.tooltip.borderColor = chartTheme.tooltipBorder;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = cssVar("--text", "#edf3f8");
  Chart.defaults.plugins.tooltip.bodyColor = cssVar("--muted", "#9aabba");
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.plugins.tooltip.displayColors = false;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

applyChartDefaults();

const LAYER_TIPS = {
  lan: { name: "LAN", meaning: "Router or gateway unreachable. This is a local network issue." },
  wan: { name: "WAN", meaning: "Public internet path failed while LAN is up (ISP/upstream)." },
  dns: { name: "DNS", meaning: "Name resolution failed while LAN+WAN are up. Checked only when lower layers are up." },
  http: { name: "HTTP", meaning: "Web connectivity failed while LAN+WAN+DNS are up (captive portal / HTTP path)." },
  "speed-down": {
    name: "Download",
    meaning: "Last Ookla test download throughput (Mbps), or how fast data arrives from the internet.",
  },
  "speed-up": {
    name: "Upload",
    meaning: "Last Ookla test upload throughput (Mbps), or how fast you can send data upstream.",
  },
  "speed-ping": {
    name: "Ping",
    meaning: "Round-trip latency to the test server (ms). Jitter is how much that latency varies.",
  },
  "speed-loss": {
    name: "Packet loss",
    meaning:
      "Share of test packets that never arrived. Healthy home broadband is usually under 1% (ideally ~0%). Around 1-2% can cause lag or glitches; above ~2-5% is often noticeable on calls and games.",
  },
  "conn-proto": {
    name: "Protocol",
    meaning: "TCP or UDP for this endpoint.",
  },
  "conn-process": {
    name: "Process",
    meaning:
      "Executable that owns the socket. \"?\" means the name could not be resolved (other users or protected system processes often need Run as administrator).",
  },
  "conn-pid": {
    name: "PID",
    meaning: "Windows process ID that owns this connection (OwningProcess).",
  },
  "conn-local": {
    name: "Local",
    meaning: "Local IP address and port on this machine.",
  },
  "conn-remote": {
    name: "Remote",
    meaning: "Remote peer address and port. UDP endpoints show \"-\" (no remote).",
  },
  "conn-state": {
    name: "State",
    meaning: "TCP state (e.g. Established, Listen, TimeWait). UDP endpoints are shown as Listen.",
  },
  "conn-adapter-mbps": {
    name: "Adapter throughput",
    meaning:
      "Estimated receive (↓) and send (↑) rate in Mbps from consecutive snapshots. \"-\" until a second sample arrives (or after refresh resets the baseline).",
  },
};

let sparkChart, hourChart, dowChart, latencyChart, speedTrendChart, usageTrendChart;
let speedRunning = false;
let connAutoRefreshTimer = null;
let connView = "devices";
let sniffPollTimer = null;
let lastUsageLiveApps = [];
let chartEnterDone = { spark: false, latency: false, hour: false, dow: false, speed: false };
const HISTORY_ROW_LIMIT = 100;
let chartTipAnchor = null;
let chartTipScrollWired = false;

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

function fmtTs(ts) {
  if (ts == null) return "-";
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  if (n == null || Number.isNaN(Number(n))) return "-";
  return Number(n).toFixed(1);
}

function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b)) return "-";
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtMs(n) {
  if (n == null || Number.isNaN(Number(n))) return "-";
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
    if (path.startsWith("/api/connections/snapshot")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("establishedOnly") === "1" || q.get("established_only") === "1") {
        params.establishedOnly = true;
      }
      return window.idt.connectionsSnapshot(params);
    }
    if (path === "/api/usage/status") return window.idt.usageStatus();
    if (path === "/api/usage/live") return window.idt.usageLive();
    if (path === "/api/usage/enable") return window.idt.usageEnable();
    if (path.startsWith("/api/usage/history")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("from")) params.from = q.get("from");
      if (q.get("to")) params.to = q.get("to");
      if (q.get("granularity")) params.granularity = q.get("granularity");
      if (q.get("app_key")) params.app_key = q.get("app_key");
      return window.idt.usageHistory(params);
    }
    if (path === "/api/usage/clear") return window.idt.usageClear();
    if (path === "/api/usage/ignore") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.usageIgnore(body);
    }
    if (path.startsWith("/api/usage/export")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("from")) params.from = q.get("from");
      if (q.get("to")) params.to = q.get("to");
      if (q.get("granularity")) params.granularity = q.get("granularity");
      return window.idt.usageExport(params);
    }
    if (path === "/api/usage/block") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.usageBlock(body);
    }
    if (path === "/api/usage/unblock") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.usageUnblock(body);
    }
    if (path === "/api/lan/devices") return window.idt.lanDevices();
    if (path === "/api/lan/devices/refresh") return window.idt.lanDevicesRefresh();
    if (path === "/api/lan/devices/update") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.lanDevicesUpdate(body);
    }
    if (path.startsWith("/api/lan/devices/export")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      return window.idt.lanDevicesExport({ format: q.get("format") || "csv" });
    }
    if (path === "/api/lan/wol") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.lanWol(body);
    }
    if (path === "/api/lan/topology") return window.idt.lanTopology();
    if (path === "/api/lan/topology/stop") return window.idt.lanTopologyStop();
    if (path === "/api/lan/sniffer/status") return window.idt.lanSnifferStatus();
    if (path === "/api/lan/sniffer/start") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.lanSnifferStart(body);
    }
    if (path === "/api/lan/sniffer/stop") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.lanSnifferStop(body);
    }
    if (path.startsWith("/api/lan/sniffer/events")) {
      const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      const params = {};
      if (q.get("proto")) params.proto = q.get("proto");
      if (q.get("host")) params.host = q.get("host");
      if (q.get("port")) params.port = q.get("port");
      return window.idt.lanSnifferEvents(params);
    }
    if (path === "/api/lan/scan") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.lanScan(body);
    }
    if (path === "/api/lan/discovery") return window.idt.lanDiscovery();
    if (path === "/api/lan/router-notify") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return window.idt.lanRouterNotify(body);
    }
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
  throw new Error("API unavailable");
}

function setPill(el, label, ok) {
  if (!el) return;
  el.textContent = label;
  const tip = el.classList.contains("has-tip") ? " has-tip" : "";
  el.className =
    "pill" + tip + " " + (ok === true ? "pill-ok" : ok === false ? "pill-down" : "pill-unknown");
}

function activateTab(tab, { focusPanel = false } = {}) {
  const btn = $(`.tab[data-tab="${tab}"]`);
  if (!btn) return;
  hideChartTip();
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
    resetPatternsCharts();
    refreshSummary().then((sum) => remountPatternsCharts(sum));
    refreshLongest();
  }
  if (tab === "history") {
    refreshHistoryToNow();
    refreshHistory();
  }
  if (tab === "system-logs") refreshSystemLogs({ refresh: false });
  if (tab === "connections") {
    setConnView(connView || "devices");
  } else {
    stopConnAutoRefresh();
    stopSniffPoll();
    if (window.idt && window.idt.lanSnifferStop) {
      window.idt.lanSnifferStop({}).catch(() => {});
    }
  }
  if (tab === "speed") {
    resetSpeedTrendChart();
    refreshSpeed().then(() => queueSpeedTrendMount(lastSpeedTrendTests));
  }
  if (tab === "settings") loadSettings().catch(() => {});
  if (tab === "overview") {
    refreshStatus();
    refreshSummary().then(() => scheduleChartsResize());
  }
  if (focusPanel) {
    const panel = document.getElementById(`panel-${tab}`);
    const first = panel?.querySelector(
      'button:not([hidden]), [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (first) first.focus();
  } else {
    btn.focus();
  }
  // After panel show/hide + CSS animation, force Chart.js to the live box size.
  scheduleChartsResize();
}

/** HTML chart tips via direct mouse→scale mapping (Chart.js hit-testing is flaky here). */
function ensureChartTipEl() {
  let el = document.getElementById("chartJsTooltip");
  if (el) return el;
  el = document.createElement("div");
  el.id = "chartJsTooltip";
  el.className = "chart-js-tooltip";
  el.setAttribute("role", "tooltip");
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function hideChartTip() {
  const el = document.getElementById("chartJsTooltip");
  if (el) {
    el.classList.remove("is-open", "is-below");
    el.hidden = true;
  }
  if (chartTipAnchor) {
    chartTipAnchor.removeAttribute("aria-describedby");
    chartTipAnchor = null;
  }
}

function showChartTipHtml(html, clientX, clientY) {
  const el = ensureChartTipEl();
  el.hidden = false;
  el.innerHTML = html;
  el.classList.remove("is-below");
  el.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - 8))}px`;
  el.style.top = `${Math.max(8, clientY)}px`;
  el.classList.add("is-open");
  const th = el.offsetHeight;
  if (clientY - th - 10 < 8) {
    el.classList.add("is-below");
    el.style.top = `${Math.min(window.innerHeight - 8, clientY)}px`;
  }
}

function chartTipPayloadAt(chart, index) {
  const fmt = chart.$tipFormat;
  if (!fmt) return null;
  const payload = fmt(index, chart);
  if (!payload || (!payload.title && !(payload.lines && payload.lines.length))) return null;
  return (
    (payload.title ? `<span class="tip-title">${escapeHtml(String(payload.title))}</span>` : "") +
    (payload.lines || [])
      .map((ln) => `<span class="tip-line">${escapeHtml(String(ln))}</span>`)
      .join("")
  );
}

function chartTipCoordsForIndex(chart, index) {
  const canvas = chart.canvas;
  const area = chart.chartArea;
  const xScale = chart.scales?.x;
  if (!canvas || !area || !xScale) return null;
  const cx = xScale.getPixelForValue(index);
  const rect = canvas.getBoundingClientRect();
  return {
    clientX: rect.left + (cx / chart.width) * rect.width,
    clientY: rect.top + ((area.top + area.bottom) / 2 / chart.height) * rect.height,
  };
}

function openChartTip(chart, index, clientX, clientY) {
  const html = chartTipPayloadAt(chart, index);
  if (!html) {
    hideChartTip();
    return;
  }
  chart.$tipIndex = index;
  showChartTipHtml(html, clientX, clientY);
  const canvas = chart.canvas;
  if (canvas) {
    chartTipAnchor = canvas;
    canvas.setAttribute("aria-describedby", "chartJsTooltip");
  }
}

function setupChartTipGlobal() {
  if (chartTipScrollWired) return;
  chartTipScrollWired = true;
  window.addEventListener("scroll", () => hideChartTip(), true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideChartTip();
  });
}

function unwireChartTip(chart) {
  if (!chart || !chart.$tipWired) return;
  const canvas = chart.canvas;
  const h = chart.$tipHandlers;
  if (canvas && h) {
    if (h.mousemove) canvas.removeEventListener("mousemove", h.mousemove);
    if (h.mouseleave) canvas.removeEventListener("mouseleave", h.mouseleave);
    if (h.keydown) canvas.removeEventListener("keydown", h.keydown);
    if (h.blur) canvas.removeEventListener("blur", h.blur);
  }
  if (canvas) {
    canvas.removeAttribute("tabindex");
    canvas.removeAttribute("aria-describedby");
    canvas.removeAttribute("role");
  }
  if (chartTipAnchor === canvas) chartTipAnchor = null;
  chart.$tipWired = false;
  chart.$tipHandlers = null;
  chart.$tipFormat = null;
  chart.$tipIndex = null;
}

function wireChartTip(chart, formatIndex) {
  if (!chart) return;
  unwireChartTip(chart);
  chart.$tipWired = true;
  chart.$tipFormat = formatIndex;
  chart.$tipIndex = null;
  const canvas = chart.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.style.pointerEvents = "auto";

  const onMouseMove = (evt) => {
    const area = chart.chartArea;
    const xScale = chart.scales?.x;
    if (!area || !xScale) {
      hideChartTip();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      hideChartTip();
      return;
    }
    const x = ((evt.clientX - rect.left) / rect.width) * chart.width;
    const y = ((evt.clientY - rect.top) / rect.height) * chart.height;
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
      hideChartTip();
      return;
    }
    let index = xScale.getValueForPixel(x);
    if (typeof index !== "number" || Number.isNaN(index)) {
      hideChartTip();
      return;
    }
    index = Math.round(index);
    const n = chart.data.labels?.length || 0;
    if (index < 0 || index >= n) {
      hideChartTip();
      return;
    }
    openChartTip(chart, index, evt.clientX, evt.clientY);
  };

  const onKeyDown = (evt) => {
    if (evt.key === "Escape") {
      hideChartTip();
      return;
    }
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(evt.key)) return;
    evt.preventDefault();
    const n = chart.data.labels?.length || 0;
    if (n === 0) return;
    let index = chart.$tipIndex ?? 0;
    if (evt.key === "ArrowRight") index = Math.min(n - 1, index + 1);
    if (evt.key === "ArrowLeft") index = Math.max(0, index - 1);
    if (evt.key === "Home") index = 0;
    if (evt.key === "End") index = n - 1;
    const coords = chartTipCoordsForIndex(chart, index);
    if (!coords) return;
    openChartTip(chart, index, coords.clientX, coords.clientY);
  };

  chart.$tipHandlers = {
    mousemove: onMouseMove,
    mouseleave: hideChartTip,
    keydown: onKeyDown,
    blur: hideChartTip,
  };
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseleave", hideChartTip);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("blur", hideChartTip);
  setupChartTipGlobal();
}

function chartBarPlugins() {
  return {
    legend: { display: false },
    tooltip: { enabled: false },
  };
}

function barTipFormatter(unitSingular, unitPlural) {
  return (index, chart) => {
    const title = chart.data.labels?.[index] ?? "";
    const v = chart.data.datasets?.[0]?.data?.[index];
    if (v == null || Number.isNaN(Number(v))) {
      return { title, lines: ["No data"] };
    }
    const n = Number(v);
    const unit = n === 1 ? unitSingular : unitPlural;
    return { title, lines: [`${n} ${unit}`] };
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
    x: {
      grid: { color: chartTheme.grid },
      ticks: { autoSkip: true, maxRotation: 0, maxTicksLimit: 6 },
    },
    y: {
      beginAtZero: true,
      grid: { color: chartTheme.grid },
      ticks: { maxTicksLimit: 6 },
    },
  };
}

function chartPanelHidden(canvas) {
  return !!canvas?.closest(".panel")?.hasAttribute("hidden");
}

function patternsPanelVisible() {
  const panel = document.getElementById("panel-patterns");
  return !!(panel && !panel.hidden && panel.classList.contains("active"));
}

function chartBoxReady(canvas) {
  const box = canvas?.closest(".chart-box") || canvas?.parentElement;
  if (!box) return false;
  return box.clientWidth >= 8 && box.clientHeight >= 8;
}

function scheduleChartsResize() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      Chart.defaults.devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
      for (const c of [sparkChart, latencyChart, hourChart, dowChart, speedTrendChart, usageTrendChart]) {
        fitChartToBox(c);
      }
    });
  });
}

function resizeChartSoon(chart) {
  if (!chart) return;
  requestAnimationFrame(() => fitChartToBox(chart));
}

function setupChartResize() {
  let raf = 0;
  const schedule = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      scheduleChartsResize();
    });
  };
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  // Catch layout changes that don't always emit window.resize in Electron.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(schedule);
    document.querySelectorAll(".chart-box").forEach((el) => ro.observe(el));
    const main = document.querySelector("main");
    if (main) ro.observe(main);
  }
}

function resetPatternsCharts() {
  for (const key of ["hour", "dow"]) {
    const chart = key === "hour" ? hourChart : dowChart;
    if (!chart) continue;
    unwireChartTip(chart);
    try {
      chart.destroy();
    } catch {
      /* ignore */
    }
    chartEnterDone[key] = false;
  }
  hourChart = null;
  dowChart = null;
}

function prepCanvasBox(canvas) {
  const box = canvas.closest(".chart-box");
  const rect = box?.getBoundingClientRect();
  const w = Math.max(16, Math.floor(rect?.width || 300));
  const h = Math.max(16, Math.floor(rect?.height || 200));
  canvas.style.display = "block";
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  return { w, h };
}

let lastPatternsSum = null;

/** Remount Patterns charts after the panel has real layout (avoids 0-height Chart.js canvases). */
function remountPatternsCharts(sum) {
  if (sum) lastPatternsSum = sum;
  if (!patternsPanelVisible()) return;
  resetPatternsCharts();
  const data = lastPatternsSum || sum || {};
  const run = (attempt = 0) => {
    if (!patternsPanelVisible()) return;
    const hourCanvas = $("#hourChart");
    const dowCanvas = $("#dowChart");
    if (!chartBoxReady(hourCanvas) || !chartBoxReady(dowCanvas)) {
      if (attempt < 60) requestAnimationFrame(() => run(attempt + 1));
      return;
    }
    ensureHour(data.by_hour || []);
    ensureDow(data.by_dow || []);
    fitChartToBox(hourChart);
    fitChartToBox(dowChart);
  };
  requestAnimationFrame(() => requestAnimationFrame(() => run(0)));
}

function chartAnimOnce(_key) {
  // Animations race Electron layout/resize: Chart.js defers resize while animating,
  // leaving blank canvases whose scales still power our custom tooltips.
  return false;
}

function fitChartToBox(chart) {
  if (!chart?.canvas) return;
  const box = chart.canvas.closest(".chart-box");
  if (!box) return;
  const rect = box.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w < 16 || h < 16) return;
  try {
    if (typeof chart.stop === "function") chart.stop();
    chart.options.devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    chart.canvas.style.width = `${w}px`;
    chart.canvas.style.height = `${h}px`;
    chart.resize(w, h);
    if (typeof chart.draw === "function") chart.draw();
  } catch {
    /* torn down */
  }
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
    if (!chartPanelHidden(ctx)) resizeChartSoon(sparkChart);
    return;
  }
  if (chartPanelHidden(ctx)) return;
  sparkChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Downtime (s)",
        data: values,
        backgroundColor: chartTheme.domain.lan,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: chartBarPlugins(),
      scales: {
        ...chartScaleOpts(),
        y: { ...chartScaleOpts().y, ticks: { callback: (v) => `${v}s` } },
      },
    },
  });
  wireChartTip(sparkChart, barTipFormatter("second downtime", "seconds downtime"));
  resizeChartSoon(sparkChart);
}

function latencySparkLabels(n) {
  const count = Math.max(1, n);
  const start = Date.now() - 6 * 3600_000;
  // Sparse labels only. Chart.js still plots all points; dense time strings overlap.
  const labelEvery = Math.max(1, Math.ceil(count / 6));
  return Array.from({ length: count }, (_, i) => {
    if (i % labelEvery !== 0 && i !== count - 1) return "";
    const t = start + (i / Math.max(1, count - 1)) * 6 * 3600_000;
    return new Date(t).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  });
}

function ensureLatency(data) {
  const ctx = $("#latencyChart");
  const empty = $("#latencyEmpty");
  if (!ctx) return;
  const series = Array.isArray(data) ? data : [];
  const has = series.some((v) => v != null);
  const wrap = ctx.closest(".chart-wrap");
  if (wrap) wrap.classList.toggle("is-empty", !has);
  if (empty) {
    empty.hidden = has;
    empty.setAttribute("aria-hidden", has ? "true" : "false");
  }
  if (!has) {
    if (latencyChart) {
      unwireChartTip(latencyChart);
      latencyChart.destroy();
      latencyChart = null;
      chartEnterDone.latency = false;
    }
    hideChartTip();
    return;
  }
  const labels = latencySparkLabels(series.length);
  const values = series.map((v) => (v == null ? null : Number(v)));
  if (latencyChart) {
    latencyChart.data.labels = labels;
    latencyChart.data.datasets[0].data = values;
    latencyChart.update("none");
    if (!chartPanelHidden(ctx)) resizeChartSoon(latencyChart);
    return;
  }
  if (chartPanelHidden(ctx)) return;
  latencyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Latency",
        data: values,
        borderColor: chartTheme.domain.latency,
        backgroundColor: "rgba(91, 159, 212, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 16,
        spanGaps: true,
      }],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        ...chartScaleOpts(),
        y: {
          ...chartScaleOpts().y,
          beginAtZero: true,
          ticks: { callback: (v) => `${v} ms` },
        },
      },
    },
  });
  wireChartTip(latencyChart, (index, chart) => {
    const title = chart.data.labels?.[index] ?? "";
    const v = chart.data.datasets?.[0]?.data?.[index];
    if (v == null || Number.isNaN(Number(v))) {
      return { title, lines: ["No sample"] };
    }
    return { title, lines: [`${v} ms`] };
  });
  resizeChartSoon(latencyChart);
}

function ensureHour(data) {
  const ctx = $("#hourChart");
  const empty = $("#hourEmpty");
  if (!ctx) return;
  const values = Array.isArray(data) ? data : [];
  const has = values.some((v) => Number(v) > 0);
  const wrap = ctx.closest(".chart-wrap");
  if (wrap) wrap.classList.toggle("is-empty", !has);
  if (empty) {
    empty.hidden = has;
    empty.setAttribute("aria-hidden", has ? "true" : "false");
  }
  if (!has) {
    if (hourChart) {
      unwireChartTip(hourChart);
      hourChart.destroy();
      hourChart = null;
      chartEnterDone.hour = false;
    }
    hideChartTip();
    return;
  }
  // Never touch Chart.js while Patterns is hidden. Resize-to-zero blanks the canvas.
  // while tooltips still work off stale scales.
  if (!patternsPanelVisible() || !chartBoxReady(ctx)) return;
  const labels = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? `${i}:00` : ""));
  if (hourChart) {
    hourChart.data.labels = labels;
    hourChart.data.datasets[0].data = values;
    fitChartToBox(hourChart);
    return;
  }
  prepCanvasBox(ctx);
  hourChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Outage starts",
        data: values,
        backgroundColor: chartTheme.domain.dns,
        borderColor: "rgba(91, 159, 212, 0.95)",
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: chartBarPlugins(),
      scales: {
        ...chartScaleOpts(),
        y: { ...chartScaleOpts().y, ticks: { stepSize: 1 } },
      },
    },
  });
  wireChartTip(hourChart, barTipFormatter("outage start", "outage starts"));
  fitChartToBox(hourChart);
}

function ensureDow(data) {
  const ctx = $("#dowChart");
  const empty = $("#dowEmpty");
  if (!ctx) return;
  const values = Array.isArray(data) ? data : [];
  const has = values.some((v) => Number(v) > 0);
  const wrap = ctx.closest(".chart-wrap");
  if (wrap) wrap.classList.toggle("is-empty", !has);
  if (empty) {
    empty.hidden = has;
    empty.setAttribute("aria-hidden", has ? "true" : "false");
  }
  if (!has) {
    if (dowChart) {
      unwireChartTip(dowChart);
      dowChart.destroy();
      dowChart = null;
      chartEnterDone.dow = false;
    }
    hideChartTip();
    return;
  }
  if (!patternsPanelVisible() || !chartBoxReady(ctx)) return;
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (dowChart) {
    dowChart.data.labels = labels;
    dowChart.data.datasets[0].data = values;
    fitChartToBox(dowChart);
    return;
  }
  prepCanvasBox(ctx);
  dowChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Outage starts",
        data: values,
        backgroundColor: chartTheme.domain.wan,
        borderColor: "rgba(230, 180, 80, 0.95)",
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: chartBarPlugins(),
      scales: chartScaleOpts(),
    },
  });
  wireChartTip(dowChart, barTipFormatter("outage start", "outage starts"));
  fitChartToBox(dowChart);
}

function speedTrendLabels(rows) {
  return rows.map((t) => {
    const d = new Date(Number(t.tested_at) * 1000);
    if (Number.isNaN(d.getTime())) return "-";
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${md} ${hm}`;
  });
}

function speedPanelVisible() {
  const panel = document.getElementById("panel-speed");
  return !!(panel && !panel.hidden && panel.classList.contains("active"));
}

let lastSpeedTrendTests = [];
let speedTrendMountRaf = 0;

function resetSpeedTrendChart() {
  if (!speedTrendChart) return;
  unwireChartTip(speedTrendChart);
  try {
    speedTrendChart.destroy();
  } catch {
    /* ignore */
  }
  speedTrendChart = null;
  chartEnterDone.speed = false;
}

/** Create/fit the throughput chart only after the Speed panel box has real pixels. */
function queueSpeedTrendMount(tests, attempt = 0) {
  if (tests) lastSpeedTrendTests = Array.isArray(tests) ? tests : [];
  if (speedTrendMountRaf) cancelAnimationFrame(speedTrendMountRaf);
  speedTrendMountRaf = requestAnimationFrame(() => {
    speedTrendMountRaf = 0;
    if (!speedPanelVisible()) return;
    const ctx = $("#speedTrendChart");
    if (!ctx || !chartBoxReady(ctx)) {
      if (attempt < 60) queueSpeedTrendMount(null, attempt + 1);
      return;
    }
    buildSpeedTrendChart(lastSpeedTrendTests);
  });
}

function buildSpeedTrendChart(tests) {
  const ctx = $("#speedTrendChart");
  const empty = $("#speedTrendEmpty");
  if (!ctx || !speedPanelVisible()) return;

  const rows = [...(tests || [])]
    .filter((t) => t && t.tested_at != null)
    .sort((a, b) => Number(a.tested_at) - Number(b.tested_at));
  const has = rows.length > 0;
  const wrap = ctx.closest(".chart-wrap");
  if (wrap) wrap.classList.toggle("is-empty", !has);
  if (empty) {
    empty.textContent = "No speed tests yet. Run a test to build history.";
    empty.hidden = has;
    empty.setAttribute("aria-hidden", has ? "true" : "false");
  }
  if (!has) {
    resetSpeedTrendChart();
    hideChartTip();
    return;
  }

  const labels = speedTrendLabels(rows);
  const down = rows.map((t) => Number(t.download_mbps));
  const up = rows.map((t) => Number(t.upload_mbps));
  const yMax = Math.max(...down.filter((n) => !Number.isNaN(n)), ...up.filter((n) => !Number.isNaN(n)), 10) * 1.1;

  if (speedTrendChart) {
    speedTrendChart.data.labels = labels;
    speedTrendChart.data.datasets[0].data = down;
    speedTrendChart.data.datasets[1].data = up;
    speedTrendChart.options.scales.y.suggestedMax = yMax;
    fitChartToBox(speedTrendChart);
    return;
  }

  // Pre-size canvas before Chart.js init (responsive:false starts blank otherwise).
  prepCanvasBox(ctx);

  speedTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Down",
          data: down,
          borderColor: chartTheme.domain.down,
          backgroundColor: "transparent",
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointHitRadius: 16,
        },
        {
          label: "Up",
          data: up,
          borderColor: chartTheme.domain.up,
          backgroundColor: "transparent",
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointHitRadius: 16,
        },
      ],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 10 } },
        tooltip: { enabled: false },
      },
      scales: {
        ...chartScaleOpts(),
        y: {
          ...chartScaleOpts().y,
          suggestedMax: yMax,
          ticks: { callback: (v) => `${v}` },
        },
      },
    },
  });
  wireChartTip(speedTrendChart, (index, chart) => {
    const title = chart.data.labels?.[index] ?? "";
    const lines = (chart.data.datasets || []).map((ds) => {
      const v = ds.data?.[index];
      if (v == null || Number.isNaN(Number(v))) return `${ds.label}: -`;
      return `${ds.label}: ${Number(v).toFixed(1)} Mbps`;
    });
    return { title, lines };
  });
  fitChartToBox(speedTrendChart);
}

function ensureSpeedTrend(tests) {
  lastSpeedTrendTests = Array.isArray(tests) ? tests : [];
  const ctx = $("#speedTrendChart");
  const empty = $("#speedTrendEmpty");
  if (!ctx) return;
  const rows = lastSpeedTrendTests.filter((t) => t && t.tested_at != null);
  const has = rows.length > 0;
  const wrap = ctx.closest(".chart-wrap");
  if (wrap) wrap.classList.toggle("is-empty", !has);
  if (empty) {
    empty.textContent = "No speed tests yet. Run a test to build history.";
    empty.hidden = has;
    empty.setAttribute("aria-hidden", has ? "true" : "false");
  }
  if (!has) {
    resetSpeedTrendChart();
    hideChartTip();
    return;
  }
  if (!speedPanelVisible()) return;
  queueSpeedTrendMount(lastSpeedTrendTests);
}

function parseSnapshot(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatSnapshotBlock(label, snap) {
  if (!snap) return "";
  const a = snap.adapter;
  const adapter =
    a && a.name
      ? `${a.type === "wifi" ? "Wi‑Fi" : a.type === "ethernet" ? "Ethernet" : "Adapter"} ${a.name}${
          a.signal != null ? ` ${a.signal}%` : ""
        }`
      : "adapter -";
  const flags = [
    `LAN ${snap.lan_ok === true ? "up" : snap.lan_ok === false ? "down" : "-"}`,
    `WAN ${snap.wan_ok === true ? "up" : snap.wan_ok === false ? "down" : "-"}`,
    `DNS ${snap.dns_ok === true ? "up" : snap.dns_ok === false ? "down" : "-"}`,
    `HTTP ${snap.http_ok === true ? "up" : snap.http_ok === false ? "down" : "-"}`,
  ].join(" · ");
  const lat = snap.latency_ms != null ? `${Math.round(snap.latency_ms)} ms` : "-";
  const gw = snap.gateway || "-";
  return `<div><strong>${escapeHtml(label)}</strong> · ${escapeHtml(adapter)} · gw ${escapeHtml(gw)} · ${escapeHtml(lat)}<br>${escapeHtml(flags)}</div>`;
}

function emptyStateHtml(cols, title, body) {
  return `<tr><td colspan="${cols}" class="empty-state">
    <p class="empty-state-title">${escapeHtml(title)}</p>
    <p class="empty-state-body">${escapeHtml(body)}</p>
  </td></tr>`;
}

function renderOutageRows(tbody, rows, {
  showEnded = true,
  editableNotes = false,
  emptyMsg = "No outages",
  emptyTitle = null,
  expandable = false,
} = {}) {
  const now = Date.now() / 1000;
  const cols = (showEnded ? 5 : 4) + (expandable ? 1 : 0);
  if (!rows.length) {
    tbody.innerHTML = emptyStateHtml(
      cols,
      emptyTitle || emptyMsg,
      emptyTitle ? emptyMsg : "Try a wider range or clear filters."
    );
    return;
  }
  tbody.innerHTML = rows.map((o) => {
    const open = o.ended_at == null;
    const dur = o.duration_ms != null ? o.duration_ms : Math.floor((now - o.started_at) * 1000);
    const typ = safeOutageType(o.type);
    const snap = parseSnapshot(o.snapshot_json);
    const hasSnap = !!(snap && (snap.at_open || snap.at_close || snap.adapter || snap.lan_ok != null));
    const notesCell = editableNotes
      ? `<td class="notes-cell">
          <input type="text" class="notes-input" data-outage-id="${Number(o.id)}"
            value="${escapeHtml(o.notes || "")}" maxlength="2000" placeholder="Add note…"
            aria-label="Outage note" />
        </td>`
      : `<td>${o.notes ? escapeHtml(o.notes) : ""}</td>`;
    const expandBtn = expandable
      ? `<td>${hasSnap
        ? `<button type="button" class="row-expand" aria-expanded="false" aria-controls="snapshot-${Number(o.id)}" aria-label="Show incident snapshot" data-expand="${Number(o.id)}">▸</button>`
        : ""}</td>`
      : "";
    const detail = expandable && hasSnap
      ? `<tr class="snapshot-row" id="snapshot-${Number(o.id)}" hidden data-for="${Number(o.id)}">
          <td colspan="${cols}" class="snapshot-detail">
            ${formatSnapshotBlock("Opened", snap.at_open || (snap.adapter || snap.lan_ok != null ? snap : null))}
            ${formatSnapshotBlock("Closed", snap.at_close)}
          </td>
        </tr>`
      : "";
    return `<tr class="${open ? "open-row" : ""}" data-outage-row="${Number(o.id)}">
      ${expandBtn}
      <td class="type-${typ}">${escapeHtml(typ.toUpperCase())}</td>
      <td>${fmtTs(o.started_at)}</td>
      ${showEnded ? `<td>${open ? "ongoing" : fmtTs(o.ended_at)}</td>` : ""}
      <td class="dur">${fmtDuration(dur)}${open ? "…" : ""}</td>
      ${notesCell}
    </tr>${detail}`;
  }).join("");

  if (expandable) {
    tbody.querySelectorAll(".row-expand").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-expand");
        const detail = tbody.querySelector(`.snapshot-row[data-for="${id}"]`);
        if (!detail) return;
        const open = detail.hidden;
        detail.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        btn.setAttribute("aria-label", open ? "Hide incident snapshot" : "Show incident snapshot");
        btn.textContent = open ? "▾" : "▸";
      });
    });
  }

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
          input.removeAttribute("aria-invalid");
          input.classList.add("saved");
          const notesLive = $("#notesLive");
          if (notesLive) {
            notesLive.textContent = "Note saved";
            setTimeout(() => { notesLive.textContent = ""; }, 1500);
          }
          setTimeout(() => input.classList.remove("saved"), 800);
        } catch (err) {
          console.error(err);
          input.classList.add("error");
          input.setAttribute("aria-invalid", "true");
          const notesLive = $("#notesLive");
          if (notesLive) {
            notesLive.textContent = `Could not save note: ${err.message || err}`;
          }
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
    return `<span class="split-pill ${k} pressable">${k.toUpperCase()} ${fmtDuration(w.downtime_ms)} · ${w.count || 0}</span>`;
  }).filter(Boolean);
  el.innerHTML = parts.join("") || `<span class="split-pill">No events</span>`;
}

function renderTimeline(el, events, { now = Date.now() / 1000 } = {}) {
  if (!el) return;
  const start = now - 86400;
  const span = 86400;
  const rows = events || [];
  if (!rows.length) {
    el.innerHTML = `<div class="timeline-empty empty-state">
      <p class="empty-state-title">Clear stretch</p>
      <p class="empty-state-body muted">No outages in the last 24 hours</p>
    </div>`;
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
    return `<div class="tl-block ${typ} has-tip" style="left:${left}%;width:${width}%"
      tabindex="0" role="img" data-tip-text="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></div>`;
  }).join("");
  el.innerHTML = `<div class="timeline-track">${blocks}</div>
    <div class="timeline-axis"><span>−24h</span><span>−12h</span><span>now</span></div>`;
  bindTooltips(el);
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
    if ($("#providerIsp")) $("#providerIsp").textContent = "-";
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

function paintQuality(q) {
  const strip = $("#qualityStrip");
  if (!strip) return;
  const has = q && (q.loss_pct != null || q.jitter_ms != null || q.latency_avg_ms != null);
  strip.classList.toggle("has-data", !!has);
  if ($("#qualityLoss")) {
    $("#qualityLoss").textContent = q && q.loss_pct != null ? `${q.loss_pct}%` : "-";
  }
  if ($("#qualityJitter")) {
    $("#qualityJitter").textContent = q && q.jitter_ms != null ? `${q.jitter_ms} ms` : "-";
  }
  if ($("#qualityAvg")) {
    $("#qualityAvg").textContent =
      q && q.latency_avg_ms != null ? `${q.latency_avg_ms} ms` : "-";
  }
  if ($("#qualityLast")) {
    $("#qualityLast").textContent =
      q && q.latency_ms != null ? `${q.latency_ms} ms` : "-";
  }
}

let lastAnnouncedStatus = "";

function paintStatus(s) {
  if (!s) return;
  setPill($("#pillLan"), `LAN ${s.lan_ok === true ? "UP" : s.lan_ok === false ? "DOWN" : "-"}`, s.lan_ok);
  if (s.lan_ok === false) {
    $("#pillWan").textContent = `WAN ${s.wan_ok === true ? "UP" : "DOWN"}`;
    $("#pillWan").className = "pill has-tip " + (s.wan_ok ? "pill-ok" : "pill-amber");
  } else {
    setPill($("#pillWan"), `WAN ${s.wan_ok === true ? "UP" : s.wan_ok === false ? "DOWN" : "-"}`, s.wan_ok);
  }
  if ($("#pillDns")) {
    if (s.lan_ok !== true || s.wan_ok !== true) {
      $("#pillDns").textContent = "DNS -";
      $("#pillDns").className = "pill pill-unknown has-tip";
    } else {
      setPill($("#pillDns"), `DNS ${s.dns_ok === true ? "UP" : s.dns_ok === false ? "DOWN" : "-"}`, s.dns_ok);
    }
  }
  if ($("#pillHttp")) {
    if (s.lan_ok !== true || s.wan_ok !== true || s.dns_ok !== true) {
      $("#pillHttp").textContent = "HTTP -";
      $("#pillHttp").className = "pill pill-unknown has-tip";
    } else {
      setPill($("#pillHttp"), `HTTP ${s.http_ok === true ? "UP" : s.http_ok === false ? "DOWN" : "-"}`, s.http_ok);
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
  if ($("#heroGateway")) $("#heroGateway").textContent = s.gateway || "-";
  if ($("#heroLatency")) {
    $("#heroLatency").textContent = s.latency_ms != null ? `${Math.round(s.latency_ms)} ms` : "-";
  }

  const stale = $("#staleBanner");
  if (stale) stale.hidden = !s.monitor_stale;

  paintQuality(s.quality);

  const adapterEl = $("#adapterLine");
  if (adapterEl) {
    const a = s.adapter;
    if (a && a.name) {
      const kind = a.type === "wifi" ? "Wi‑Fi" : a.type === "ethernet" ? "Ethernet" : "Adapter";
      const sig = a.type === "wifi" && a.signal != null ? ` · ${a.signal}%` : "";
      adapterEl.textContent = `${kind} · ${a.name}${sig}`;
      adapterEl.hidden = false;
      const viewConn = $("#viewConnectionsLink");
      if (viewConn) viewConn.hidden = false;
    } else {
      adapterEl.hidden = true;
      const viewConn = $("#viewConnectionsLink");
      if (viewConn) viewConn.hidden = true;
    }
  }

  let title = "All clear";
  let sub = "LAN, WAN, DNS, and HTTP path OK";
  if (s.paused) {
    title = "Paused";
    sub = "Monitoring is paused. Resume from Settings or the tray";
  } else if (s.monitor_stale) {
    title = "Monitor stalled";
    sub = "The last probe is older than expected. Check Pause or restart";
  } else if (s.probe_suppressed) {
    title = "Speed test running";
    sub = "Probes paused so the test won’t pollute History";
  } else if (s.lan_ok === false) {
    title = "LAN down";
    sub = "Gateway unreachable. A local network issue is likely";
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
  const announcement = `${title}. ${sub}`;
  if (announcement !== lastAnnouncedStatus) {
    const live = $("#statusAnnouncement");
    if (live) live.textContent = announcement;
    lastAnnouncedStatus = announcement;
  }

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
    if (s.probe_suppressed) {
      logo.style.background = "var(--blue)";
      logo.style.boxShadow = "0 0 0 3px rgba(91,159,212,0.3)";
    } else if (s.monitor_stale) {
      logo.style.background = "var(--amber)";
      logo.style.boxShadow = "0 0 0 3px rgba(230,180,80,0.3)";
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

let lastGoodStatus = null;

async function refreshStatus() {
  try {
    const s = await api("/api/status");
    if (!s) return; // don't clobber a good paint with a null IPC result
    lastGoodStatus = s;
    paintStatus(s);
    if (s.db_degraded && $("#metaLine")) {
      const cur = $("#metaLine").textContent || "";
      if (!/db sync/i.test(cur)) {
        $("#metaLine").textContent = cur ? `${cur} · db sync delayed` : "db sync delayed";
      }
    }
  } catch (e) {
    // Keep the last good connectivity paint. A transient DB/IPC failure does not mean the network is down.
    if (lastGoodStatus) {
      if ($("#metaLine")) {
        const cur = $("#metaLine").textContent || "";
        if (!/sync delayed/i.test(cur)) {
          $("#metaLine").textContent = cur ? `${cur} · sync delayed` : "sync delayed";
        }
      }
      return;
    }
    $("#metaLine").textContent = "status unavailable";
    if ($("#statusTitle")) $("#statusTitle").textContent = "Status unavailable";
    if ($("#statusAnnouncement")) $("#statusAnnouncement").textContent = "Status unavailable";
  }
}

let lastGoodSummary = null;

async function refreshSummary() {
  try {
    const sum = await api("/api/summary");
    lastGoodSummary = sum;
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
    // Patterns charts only when that tab is visible (see remountPatternsCharts / ensureHour).
    if (patternsPanelVisible()) {
      ensureHour(sum.by_hour || []);
      ensureDow(sum.by_dow || []);
      paintPatternsSummary(sum, null);
    }
    if ($("#recentBody")) {
      renderOutageRows($("#recentBody"), sum.recent_outages || [], { showEnded: false });
      if ($("#recentMeta")) {
        $("#recentMeta").textContent = `${(sum.recent_outages || []).length} latest`;
      }
    }
    paintProvider(sum.provider);
    lastPatternsSum = sum;
    return sum;
  } catch (e) {
    console.error(e);
    if (lastGoodSummary) {
      if ($("#timelineMeta")) $("#timelineMeta").textContent = "Summary refresh delayed";
      return lastGoodSummary;
    }
    const timeline = $("#timeline24");
    if (timeline) {
      timeline.innerHTML = `<div class="timeline-empty empty-state state-error">
        <p class="empty-state-title">Summary unavailable</p>
        <p class="empty-state-body">Live monitoring continues. Reopen Overview to retry.</p>
      </div>`;
    }
    if ($("#timelineMeta")) $("#timelineMeta").textContent = "Load failed";
    return null;
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
  const tbody = $("#outageBody");
  const table = tbody?.closest("table");
  const applyBtn = form?.querySelector('button[type="submit"]');
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
  params.set("limit", String(HISTORY_ROW_LIMIT));
  if (meta) meta.textContent = "Loading…";
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  if (table) table.setAttribute("aria-busy", "true");
  if (applyBtn) applyBtn.disabled = true;
  try {
    const data = await api(`/api/outages?${params}`);
    const rows = data.outages || [];
    renderOutageRows(tbody, rows, {
      editableNotes: true,
      expandable: true,
      emptyTitle: "No outages",
      emptyMsg: "No outages in this range. Try widening From/To or clearing filters.",
    });
    if (meta) {
      const capped = rows.length >= HISTORY_ROW_LIMIT ? ` (showing first ${HISTORY_ROW_LIMIT})` : "";
      meta.textContent = `${rows.length} outage${rows.length === 1 ? "" : "s"}${capped}`;
    }
  } catch (e) {
    console.error(e);
    if (tbody) {
      tbody.innerHTML = emptyStateHtml(
        6,
        "Load failed",
        "Could not load history. Try Apply again."
      );
    }
    if (meta) meta.textContent = "Load failed";
  } finally {
    if (table) table.removeAttribute("aria-busy");
    if (applyBtn) applyBtn.disabled = false;
  }
}

const DOW_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

function peakIndex(arr) {
  let best = 0;
  let bestV = -1;
  for (let i = 0; i < (arr || []).length; i++) {
    const v = Number(arr[i]) || 0;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return { index: best, value: bestV };
}

function buildPatternsNarrative(sum, longestRows) {
  const byHour = sum?.by_hour || [];
  const byDow = sum?.by_dow || [];
  const total = byHour.reduce((a, b) => a + (Number(b) || 0), 0);
  if (!total) {
    return "Over the last 30 days there were no recorded outage starts while this tracker was watching. That usually means the path stayed up during observation. If a technician is investigating a report from outside this window, confirm monitoring was running at that time.";
  }
  const hourPeak = peakIndex(byHour);
  const dowPeak = peakIndex(byDow);
  const hourLabel = `${String(hourPeak.index).padStart(2, "0")}:00`;
  const nextHour = `${String((hourPeak.index + 1) % 24).padStart(2, "0")}:00`;
  const layerLabels = {
    lan: "local network / gateway (LAN)",
    wan: "internet path past the gateway (WAN)",
    dns: "name resolution (DNS)",
    http: "web connectivity (HTTP)",
  };
  const w7 = sum?.windows?.["7d"] || {};
  const typeBits = ["lan", "wan", "dns", "http"]
    .map((k) => ({ k, c: w7[k]?.count || 0 }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c);
  let domainBit = "";
  if (typeBits.length) {
    const lead = typeBits[0];
    domainBit = ` In the last 7 days, failures most often looked like ${layerLabels[lead.k]} (${lead.c} event${lead.c === 1 ? "" : "s"}).`;
    if (typeBits.length > 1) {
      domainBit += ` Also seen: ${typeBits.slice(1).map((t) => `${t.c} ${t.k.toUpperCase()}`).join(", ")}.`;
    }
  }
  const top = (longestRows || [])[0];
  let longestBit = "";
  if (top) {
    const open = top.ended_at == null;
    const durMs =
      top.duration_ms != null
        ? top.duration_ms
        : open
          ? Math.floor((Date.now() / 1000 - top.started_at) * 1000)
          : null;
    const dur = durMs != null ? fmtDuration(durMs) : "unknown length";
    longestBit = ` The longest outage in the table below is ${String(top.type || "?").toUpperCase()}, about ${dur}${open ? " and still open" : ""}.`;
  }
  return `Over the last 30 days this tracker recorded ${total} outage start${total === 1 ? "" : "s"}. They clustered most often around ${hourLabel}-${nextHour} local time, and more often on ${DOW_NAMES[dowPeak.index]}s than other days.${domainBit}${longestBit} Share this with a visiting technician: timing peaks and the layer that fails first usually separate a local Wi-Fi issue from an ISP or DNS problem.`;
}

function paintPatternsSummary(sum, longestRows) {
  const el = $("#patternsSummary");
  if (!el) return;
  el.textContent = buildPatternsNarrative(sum || lastPatternsSum, longestRows);
}

async function refreshLongest() {
  const form = $("#patternsFilters");
  const tbody = $("#longestBody");
  if (!tbody) return;
  const table = tbody.closest("table");
  const applyBtn = form?.querySelector('button[type="submit"]');
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
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading...</td></tr>`;
  if (table) table.setAttribute("aria-busy", "true");
  if (applyBtn) applyBtn.disabled = true;
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
    paintPatternsSummary(lastPatternsSum, rows);
  } catch (e) {
    console.error(e);
    tbody.innerHTML = emptyStateHtml(4, "Load failed", "Could not load outage patterns. Try Apply again.");
    paintPatternsSummary(lastPatternsSum, []);
  } finally {
    if (table) table.removeAttribute("aria-busy");
    if (applyBtn) applyBtn.disabled = false;
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
  const tbody = $("#systemLogsBody");
  const table = tbody?.closest("table");
  meta.textContent = refresh ? "Scanning Windows logs..." : "Loading...";
  if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading...</td></tr>`;
  if (table) table.setAttribute("aria-busy", "true");
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
    if (table) table.removeAttribute("aria-busy");
    if (applyBtn) applyBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

const CONN_AUTO_REFRESH_MS = 45000;

function stopConnAutoRefresh() {
  if (connAutoRefreshTimer) {
    clearInterval(connAutoRefreshTimer);
    connAutoRefreshTimer = null;
  }
}

function syncConnAutoRefresh() {
  stopConnAutoRefresh();
  const panel = $("#panel-connections");
  const auto = $("#connAutoRefresh");
  if (!panel || panel.hidden || connView !== "connections") return;
  if (!auto || !auto.checked) return;
  connAutoRefreshTimer = setInterval(() => refreshConnectionsPanel(), CONN_AUTO_REFRESH_MS);
}

function stopSniffPoll() {
  if (sniffPollTimer) {
    clearInterval(sniffPollTimer);
    sniffPollTimer = null;
  }
}

function setConnView(view) {
  const allowed = new Set(["devices", "connections", "usage", "topology", "sniffer", "scan"]);
  const prev = connView;
  connView = allowed.has(view) ? view : "devices";
  const views = {
    devices: $("#devicesView"),
    connections: $("#connectionsView"),
    usage: $("#usageView"),
    topology: $("#topologyView"),
    sniffer: $("#snifferView"),
    scan: $("#scanView"),
  };
  document.querySelectorAll(".conn-seg .seg-btn").forEach((btn) => {
    const v = btn.getAttribute("data-conn-view") || "";
    btn.classList.toggle("active", v === connView);
  });
  for (const [k, el] of Object.entries(views)) {
    if (el) el.hidden = k !== connView;
  }
  stopConnAutoRefresh();
  if (prev === "sniffer" && connView !== "sniffer") {
    stopSniffPoll();
    api("/api/lan/sniffer/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
  }
  if (prev === "topology" && connView !== "topology") {
    api("/api/lan/topology/stop").catch(() => {});
  }
  if (connView === "devices") refreshDevicesPanel();
  else if (connView === "connections") {
    refreshConnectionsPanel();
    syncConnAutoRefresh();
  } else if (connView === "usage") refreshUsagePanel();
  else if (connView === "topology") refreshTopologyPanel();
  else if (connView === "sniffer") refreshSnifferPanel();
  else if (connView === "scan") {
    /* idle until run */
  }
}

async function refreshDevicesPanel() {
  const meta = $("#devicesMeta");
  const tbody = $("#devicesBody");
  const strip = $("#devicesGatewayStrip");
  try {
    const data = await api("/api/lan/devices/refresh");
    const devices = data.devices || [];
    if (strip) {
      strip.innerHTML = data.gateway
        ? `<span class="meta-chip"><span class="meta-label">Gateway</span> ${escapeHtml(data.gateway)}</span>`
        : `<span class="muted">No gateway detected</span>`;
    }
    if (meta) {
      meta.textContent = `${devices.length} devices · passive neighbor cache`;
    }
    if (tbody) {
      tbody.innerHTML =
        devices
          .map((d) => {
            const pills = [];
            if (d.online) pills.push(`<span class="pill pill-ok">online</span>`);
            else pills.push(`<span class="pill pill-unknown">offline</span>`);
            if (d.gateway) pills.push(`<span class="pill">gw</span>`);
            if (d.source === "active_scan") pills.push(`<span class="pill">active scan</span>`);
            const mac = escapeHtml(d.mac || "");
            return `<tr data-mac="${mac}">
              <td>${pills.join(" ")}</td>
              <td>${escapeHtml(d.ip || "")}</td>
              <td>${mac}</td>
              <td>${escapeHtml(d.vendor || "")}</td>
              <td><input type="text" class="device-alias" data-mac="${mac}" value="${escapeHtml(d.alias || "")}" maxlength="120" aria-label="Alias" /></td>
              <td>
                <button type="button" class="btn btn-secondary device-wol" data-mac="${mac}">WOL</button>
                <button type="button" class="btn btn-secondary device-router" data-mac="${mac}">Notify router</button>
                <button type="button" class="btn btn-secondary device-scan" data-ip="${escapeHtml(d.ip || "")}">Scan</button>
                <button type="button" class="btn btn-secondary device-filter" data-ip="${escapeHtml(d.ip || "")}">Connections</button>
              </td>
            </tr>`;
          })
          .join("") || `<tr><td colspan="6" class="muted">No devices yet — click Refresh</td></tr>`;
    }
  } catch (e) {
    if (meta) meta.textContent = e.message || "Devices failed";
  }
}

function topologyLayout(nodes, edges) {
  if (!nodes.length) return { width: 720, height: 300, positions: [], rootIndex: -1 };
  const degree = new Map();
  for (const edge of edges || []) {
    for (const id of [edge.from, edge.to]) degree.set(String(id), (degree.get(String(id)) || 0) + 1);
  }
  let rootIndex = nodes.findIndex((node) => node.gateway);
  if (rootIndex < 0) {
    rootIndex = nodes.reduce((best, node, index) => {
      const score = degree.get(String(node.ip || node.label || "")) || 0;
      const bestScore = degree.get(String(nodes[best].ip || nodes[best].label || "")) || 0;
      return score > bestScore ? index : best;
    }, 0);
  }

  const placed = [];
  let offset = 0;
  let ring = 0;
  const remaining = nodes.map((node, index) => ({ node, index })).filter(({ index }) => index !== rootIndex);
  while (offset < remaining.length) {
    const capacity = 14 + ring * 8;
    const count = Math.min(capacity, remaining.length - offset);
    const radius = 92 + ring * 72;
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
      placed.push({ ...remaining[offset + i], angle, radius });
    }
    offset += count;
    ring += 1;
  }
  const maxRadius = placed.reduce((max, item) => Math.max(max, item.radius), 0);
  const width = Math.max(720, maxRadius * 2 + 100);
  const height = Math.max(300, maxRadius * 2 + 60);
  const cx = width / 2;
  const cy = height / 2;
  const positions = nodes.map((node, index) => ({ node, index, x: cx, y: cy }));
  for (const item of placed) {
    positions[item.index] = {
      node: item.node,
      index: item.index,
      x: cx + Math.cos(item.angle) * item.radius,
      y: cy + Math.sin(item.angle) * item.radius,
    };
  }
  return { width, height, positions, rootIndex };
}

function topologyNodeTip(node) {
  if (typeof window !== "undefined" && window.__idtTopologyDetailLines) {
    return window.__idtTopologyDetailLines(node).join(" · ");
  }
  const lines = [];
  const push = (label, value) => {
    const text = value == null || value === "" ? "" : String(value).trim();
    if (!text) return;
    lines.push(`${label}: ${text}`);
  };
  const status =
    node.ok === true ? "online" : node.ok === false ? node.error || "offline" : null;
  push("IP", node.ip);
  if (node.label && node.label !== node.ip) push("Name", node.label);
  push("Alias", node.alias);
  push("Hostname", node.hostname);
  push("sysName", node.sysName);
  push("Vendor", node.vendor);
  push("MAC", node.mac);
  push("Status", status);
  if (node.gateway) push("Role", "Gateway");
  push("Neighbor", node.state);
  push("IP scope", node.ip_scope);
  push("Adapter", node.iface);
  push("Source", node.source);
  if (node.first_seen) {
    try {
      push("First seen", new Date(Number(node.first_seen) * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z");
    } catch {
      /* ignore */
    }
  }
  if (node.last_seen) {
    try {
      push("Last seen", new Date(Number(node.last_seen) * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z");
    } catch {
      /* ignore */
    }
  }
  if (node.conn_count != null) push("Connections", String(node.conn_count));
  push("sysDescr", node.sysDescr);
  push("sysObjectID", node.sysObjectID);
  if (node.ifCount != null) push("Interfaces", String(node.ifCount));
  return lines.join(" · ") || String(node.ip || "device");
}

function topologyDetailHtml(node) {
  const rows = [
    ["MAC", node.mac],
    ["Vendor", node.vendor],
    ["Alias", node.alias],
    ["Hostname", node.hostname],
    ["sysName", node.sysName],
    ["Adapter", node.iface],
    ["IP scope", node.ip_scope],
    ["Neighbor state", node.state],
    ["Source", node.source],
    ["Gateway", node.gateway ? "yes" : ""],
    [
      "First seen",
      node.first_seen
        ? (() => {
            try {
              return new Date(Number(node.first_seen) * 1000).toLocaleString();
            } catch {
              return "";
            }
          })()
        : "",
    ],
    [
      "Last seen",
      node.last_seen
        ? (() => {
            try {
              return new Date(Number(node.last_seen) * 1000).toLocaleString();
            } catch {
              return "";
            }
          })()
        : "",
    ],
    ["Connections", node.conn_count != null ? String(node.conn_count) : ""],
    ["sysObjectID", node.sysObjectID],
    ["Interface count", node.ifCount != null ? String(node.ifCount) : ""],
    ["sysDescr", node.sysDescr],
  ]
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(
      ([k, v]) =>
        `<div class="topo-kv"><span class="topo-k">${escapeHtml(k)}</span><span class="topo-v">${escapeHtml(String(v))}</span></div>`
    )
    .join("");
  return rows || `<span class="muted">No extra fields</span>`;
}

function bindTopoExpands(root) {
  if (!root) return;
  root.querySelectorAll(".topo-expand").forEach((btn) => {
    if (btn.dataset.boundExpand) return;
    btn.dataset.boundExpand = "1";
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("aria-controls");
      const panel = id ? document.getElementById(id) : null;
      if (!panel) return;
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.textContent = open ? "▾" : "▸";
    });
  });
}

function topologyGraphHtml(nodes, edges) {
  if (!nodes.length) return `<div class="topo-empty muted">No topology nodes yet</div>`;
  const layout = topologyLayout(nodes, edges);
  const byId = new Map();
  for (const point of layout.positions) {
    byId.set(String(point.node.ip || point.node.label || point.index), point);
  }
  const lines = (edges || [])
    .map((edge) => {
      const from = byId.get(String(edge.from));
      const to = byId.get(String(edge.to));
      return from && to
        ? `<line class="topo-edge" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"></line>`
        : "";
    })
    .join("");
  const nodeGroups = layout.positions
    .map(({ node, index, x, y }) => {
      const isRoot = index === layout.rootIndex;
      const tip = topologyNodeTip(node);
      const rootLabel = isRoot ? String(node.gateway ? "Gateway" : node.label || node.ip || "Root").slice(0, 18) : "";
      return `<g class="topo-node-group has-tip" tabindex="0" role="img"
        aria-label="${escapeHtml(tip)}" data-tip-text="${escapeHtml(tip)}">
        <circle cx="${x}" cy="${y}" r="${isRoot ? 16 : 10}"
          class="topo-node ${node.ok ? "ok" : "bad"}${isRoot ? " root" : ""}"></circle>
        ${isRoot ? `<text x="${x}" y="${y + 30}" text-anchor="middle" class="topo-label">${escapeHtml(rootLabel)}</text>` : ""}
      </g>`;
    })
    .join("");
  const online = nodes.filter((node) => node.ok).length;
  return `<div class="topo-graph-head">
      <span>${nodes.length} devices · ${online} online</span>
      <span class="muted">Hover or focus a node for details</span>
    </div>
    <svg viewBox="0 0 ${layout.width} ${layout.height}" role="img"
      aria-label="Radial topology map with ${nodes.length} nodes">${lines}${nodeGroups}</svg>`;
}

async function refreshTopologyPanel() {
  const meta = $("#topoMeta");
  const tbody = $("#topoBody");
  const graph = $("#topoGraph");
  if (meta) meta.textContent = "Loading topology…";
  try {
    const data = await api("/api/lan/topology");
    if (meta) {
      const mode = data.mode === "neighbor" ? "neighbor map" : "SNMP";
      meta.textContent = data.ok
        ? `${(data.nodes || []).length} nodes · ${mode}${data.warning ? " — " + data.warning : ""}`
        : data.error || "Topology failed";
    }
    if (tbody) {
      tbody.innerHTML =
        (data.nodes || [])
          .map((n, idx) => {
            const tip = topologyNodeTip(n);
            const detailId = `topo-detail-${idx}`;
            const status = n.ok ? "ok" : n.error || "fail";
            return `<tr class="topo-row has-tip" tabindex="0" data-tip-text="${escapeHtml(tip)}">
            <td><button type="button" class="row-expand topo-expand" aria-expanded="false" aria-controls="${detailId}" aria-label="Show node details">▸</button></td>
            <td>${escapeHtml(n.ip || "")}</td>
            <td>${escapeHtml(n.label || "")}</td>
            <td>${escapeHtml(status)}</td>
            <td>${escapeHtml(n.state || "")}</td>
            <td>${escapeHtml(n.source || "")}</td>
            <td>${n.conn_count != null ? escapeHtml(String(n.conn_count)) : "—"}</td>
            <td>${escapeHtml(n.sysDescr || "Device")}</td>
          </tr>
          <tr id="${detailId}" class="topo-detail-row" hidden>
            <td colspan="8"><div class="topo-detail">${topologyDetailHtml(n)}</div></td>
          </tr>`;
          })
          .join("") || `<tr><td colspan="8" class="muted">No topology nodes</td></tr>`;
      bindTooltips(tbody);
      bindTopoExpands(tbody);
    }
    if (graph) {
      const nodes = data.nodes || [];
      graph.innerHTML = topologyGraphHtml(nodes, data.edges || []);
      bindTooltips(graph);
    }
  } catch (e) {
    if (meta) meta.textContent = e.message || "Topology failed";
  }
}

async function refreshSnifferPanel() {
  const q = [];
  const proto = $("#sniffProto")?.value?.trim();
  const host = $("#sniffHost")?.value?.trim();
  const port = $("#sniffPort")?.value;
  if (proto) q.push(`proto=${encodeURIComponent(proto)}`);
  if (host) q.push(`host=${encodeURIComponent(host)}`);
  if (port) q.push(`port=${encodeURIComponent(port)}`);
  const data = await api(`/api/lan/sniffer/events?${q.join("&")}`);
  const meta = $("#sniffMeta");
  if (meta) meta.textContent = data.running ? `Capturing · ${data.count || 0} buffered` : "Stopped";
  const tbody = $("#sniffBody");
  if (tbody) {
    tbody.innerHTML =
      (data.events || [])
        .map((ev) => {
          const t = ev.ts ? new Date(ev.ts * 1000).toLocaleTimeString() : "";
          return `<tr>
            <td>${escapeHtml(t)}</td>
            <td>${escapeHtml(ev.event || "")}</td>
            <td>${escapeHtml(ev.proto || "")}</td>
            <td>${escapeHtml(`${ev.src}:${ev.sport}`)}</td>
            <td>${escapeHtml(`${ev.dst}:${ev.dport}`)}</td>
            <td>${escapeHtml(ev.process || "")}</td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="6" class="muted">No events</td></tr>`;
  }
}

function startSniffPoll() {
  stopSniffPoll();
  sniffPollTimer = setInterval(() => {
    refreshSnifferPanel().catch(() => {});
  }, 2000);
}

async function runScan() {
  const host = ($("#scanTarget")?.value || "").trim();
  if (!host) {
    alert("Enter a private target IP");
    return;
  }
  if (!confirm(`Scan ${host}? Only private/local IPs are allowed.`)) return;
  const meta = $("#scanMeta");
  if (meta) meta.textContent = "Scanning…";
  try {
    const data = await api("/api/lan/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host }),
    });
    const tbody = $("#scanBody");
    const open = (data.ports || []).filter((p) => p.open);
    const cves = data.cves || [];
    if (tbody) {
      tbody.innerHTML =
        open
          .map((p) => {
            const hits = cves
              .filter((c) => c.port === p.port)
              .map((c) => `<span class="pill">${escapeHtml(c.severity)} ${escapeHtml(c.cve)}</span>`)
              .join(" ");
            return `<tr>
              <td>${p.port}</td>
              <td>${escapeHtml(p.banner || "")}</td>
              <td>${hits || "—"}</td>
            </tr>`;
          })
          .join("") || `<tr><td colspan="3" class="muted">No open ports in top set</td></tr>`;
    }
    if (meta) {
      meta.textContent = data.ok
        ? `${open.length} open · ${(data.cves || []).length} advisories (stale/offline)`
        : data.error || "Scan failed";
    }
  } catch (e) {
    if (meta) meta.textContent = e.message || "Scan failed";
  }
}

function setupConnectionsPanel() {
  document.querySelectorAll(".conn-seg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-conn-view") || "devices";
      setConnView(v);
    });
  });
  const refresh = $("#connRefresh");
  if (refresh) refresh.addEventListener("click", () => refreshConnectionsPanel());
  const established = $("#connEstablishedOnly");
  if (established) {
    established.addEventListener("change", () => refreshConnectionsPanel());
  }
  const auto = $("#connAutoRefresh");
  if (auto) auto.addEventListener("change", () => syncConnAutoRefresh());
  const usageRefresh = $("#usageRefresh");
  if (usageRefresh) usageRefresh.addEventListener("click", () => refreshUsagePanel());
  const usageEnable = $("#usageEnableBtn");
  if (usageEnable) usageEnable.addEventListener("click", () => enableUsageMonitoring());
  const usageClear = $("#usageClear");
  if (usageClear) {
    usageClear.addEventListener("click", async () => {
      if (!confirm("Clear all stored usage history?")) return;
      try {
        await api("/api/usage/clear");
        await refreshUsagePanel();
      } catch (e) {
        alert(e.message || "Clear failed");
      }
    });
  }
  const usageExport = $("#usageExport");
  if (usageExport) {
    usageExport.addEventListener("click", async () => {
      usageExport.disabled = true;
      try {
        const res = await api("/api/usage/export");
        if (res.path) alert(`Exported to ${res.path}`);
      } catch (e) {
        alert(e.message || "Export failed");
      } finally {
        usageExport.disabled = false;
      }
    });
  }
  const usageSearch = $("#usageSearch");
  if (usageSearch) {
    usageSearch.addEventListener("input", () => renderUsageLiveRows(lastUsageLiveApps));
  }
  const usageSort = $("#usageSort");
  if (usageSort) {
    usageSort.addEventListener("change", () => renderUsageLiveRows(lastUsageLiveApps));
  }
  wireUsageLiveActions();

  const devicesRefresh = $("#devicesRefresh");
  if (devicesRefresh) devicesRefresh.addEventListener("click", () => refreshDevicesPanel());
  const exportCsv = $("#devicesExportCsv");
  if (exportCsv) {
    exportCsv.addEventListener("click", async () => {
      const res = await api("/api/lan/devices/export?format=csv");
      if (res.path) alert(`Exported to ${res.path}`);
    });
  }
  const exportJson = $("#devicesExportJson");
  if (exportJson) {
    exportJson.addEventListener("click", async () => {
      const res = await api("/api/lan/devices/export?format=json");
      if (res.path) alert(`Exported to ${res.path}`);
    });
  }
  const devicesBody = $("#devicesBody");
  if (devicesBody) {
    devicesBody.addEventListener("change", async (e) => {
      const input = e.target.closest(".device-alias");
      if (!input) return;
      await api("/api/lan/devices/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac: input.getAttribute("data-mac"), alias: input.value }),
      });
    });
    devicesBody.addEventListener("click", async (e) => {
      const wol = e.target.closest(".device-wol");
      if (wol) {
        const res = await api("/api/lan/wol", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mac: wol.getAttribute("data-mac") }),
        });
        alert(res.ok ? res.tip || "WOL sent" : res.error || "WOL failed");
        return;
      }
      const router = e.target.closest(".device-router");
      if (router) {
        const res = await api("/api/lan/router-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mac: router.getAttribute("data-mac") }),
        });
        alert(res.ok ? "Router webhook sent" : res.error || "Failed");
        return;
      }
      const scanBtn = e.target.closest(".device-scan");
      if (scanBtn) {
        const ip = scanBtn.getAttribute("data-ip");
        if ($("#scanTarget")) $("#scanTarget").value = ip || "";
        setConnView("scan");
        return;
      }
      const filterBtn = e.target.closest(".device-filter");
      if (filterBtn) {
        setConnView("connections");
      }
    });
  }
  const topoRefresh = $("#topoRefresh");
  if (topoRefresh) topoRefresh.addEventListener("click", () => refreshTopologyPanel());
  const topoStop = $("#topoStop");
  if (topoStop) topoStop.addEventListener("click", () => api("/api/lan/topology/stop"));
  const sniffStart = $("#sniffStart");
  if (sniffStart) {
    sniffStart.addEventListener("click", async () => {
      await api("/api/lan/sniffer/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      startSniffPoll();
      refreshSnifferPanel();
    });
  }
  const sniffStop = $("#sniffStop");
  if (sniffStop) {
    sniffStop.addEventListener("click", async () => {
      stopSniffPoll();
      await api("/api/lan/sniffer/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      refreshSnifferPanel();
    });
  }
  const scanRun = $("#scanRun");
  if (scanRun) scanRun.addEventListener("click", () => runScan());
  const scanDiscover = $("#scanDiscover");
  if (scanDiscover) {
    scanDiscover.addEventListener("click", async () => {
      if (!confirm("Run gated subnet discovery? Probes will be suppressed while it runs.")) return;
      const meta = $("#scanMeta");
      if (meta) meta.textContent = "Discovering…";
      try {
        const res = await api("/api/lan/discovery");
        if (meta) {
          meta.textContent = res.ok
            ? `Found ${(res.found || []).length} hosts (active scan)`
            : res.error || "Discovery failed";
        }
      } catch (e) {
        if (meta) meta.textContent = e.message || "Discovery failed";
      }
    });
  }
}

function renderConnAdapters(adapters) {
  const strip = $("#connAdapterStrip");
  if (!strip) return;
  const rows = adapters || [];
  if (!rows.length) {
    strip.innerHTML = `<span class="muted">No adapter stats</span>`;
    return;
  }
  strip.innerHTML = rows.map((a) => {
    const rx = a.rx_mbps != null ? fmtMbps(a.rx_mbps) : "-";
    const tx = a.tx_mbps != null ? fmtMbps(a.tx_mbps) : "-";
    const label = a.name || "Adapter";
    return `<span class="meta-chip has-tip" tabindex="0" data-tip="conn-adapter-mbps"><span class="meta-label">${escapeHtml(label)}</span> ↓${rx} ↑${tx} Mbps</span>`;
  }).join("");
  bindTooltips(strip);
}

const CONN_STATE_TIPS = {
  established: "Established — active connection; both sides can send and receive.",
  listen: "Listen — waiting for incoming connections on this local port.",
  timewait: "TimeWait — recently closed; briefly holding the port so delayed packets don't confuse a new connection.",
  closewait: "CloseWait — remote side closed; this process still needs to close its end.",
  synsent: "SynSent — outgoing connect in progress; waiting for the peer handshake reply.",
  synreceived: "SynReceived — incoming connect in progress; handshake not finished yet.",
  finwait1: "FinWait1 — this side started closing; waiting for the peer to acknowledge.",
  finwait2: "FinWait2 — peer acknowledged our close; waiting for the peer to finish closing.",
  closing: "Closing — both sides closed at nearly the same time; finishing teardown.",
  lastack: "LastAck — waiting for the peer to acknowledge our final close.",
  closed: "Closed — no active connection (socket closed).",
  bound: "Bound — socket bound to a local address/port but not yet listening or connected.",
  deletetcb: "DeleteTCB — TCP control block being deleted (connection teardown).",
};

function tipCellAttr(text) {
  return ` class="has-tip" tabindex="0" data-tip-text="${escapeHtml(text)}"`;
}

function connProtoTip(proto) {
  const p = String(proto || "").toUpperCase();
  if (p === "TCP") return "TCP — Transmission Control Protocol: connection-oriented, reliable ordered delivery.";
  if (p === "UDP") return "UDP — User Datagram Protocol: connectionless datagrams; no delivery guarantee.";
  return p ? `Protocol: ${p}` : "Protocol for this endpoint.";
}

function connStateTip(state, proto) {
  const raw = String(state || "").trim();
  const p = String(proto || "").toUpperCase();
  if (p === "UDP") {
    return raw
      ? `UDP endpoint (shown as ${raw}) — waiting for datagrams on this local port; UDP has no TCP-style connection states.`
      : "UDP endpoint — no TCP-style connection state.";
  }
  const key = raw.toLowerCase().replace(/[\s_-]/g, "");
  if (CONN_STATE_TIPS[key]) return CONN_STATE_TIPS[key];
  return raw
    ? `${raw} — TCP connection state reported by Windows.`
    : "TCP connection state.";
}

function renderConnRows(rows) {
  const tbody = $("#connBody");
  if (!tbody) return;
  tbody.innerHTML = (rows || []).map((r) => {
    const proto = r.proto || "";
    const proc = r.process || "?";
    const unresolved = proc === "?";
    const pid = r.pid != null ? String(r.pid) : "-";
    const local = r.local || "";
    const remote = r.remote || "";
    const state = r.state || "";
    const procTip = unresolved
      ? tipCellAttr(
          "Process name unavailable for this PID (?). Your own processes should resolve without admin; other users or protected system processes may need Run as administrator."
        )
      : tipCellAttr(`Process: ${proc}`);
    const pidTip = tipCellAttr(pid === "-" ? "Process ID unavailable." : `Process ID: ${pid}`);
    const localTip = tipCellAttr(
      local ? `Local address:port — ${local}` : "Local address:port on this machine."
    );
    const remoteTip = tipCellAttr(
      !remote || remote === "-"
        ? "Remote address:port — none (typical for UDP / listening sockets)."
        : `Remote address:port — ${remote}`
    );
    return `<tr>
      <td${tipCellAttr(connProtoTip(proto))}>${escapeHtml(proto)}</td>
      <td><span${procTip}>${escapeHtml(proc)}</span></td>
      <td${pidTip}>${escapeHtml(pid)}</td>
      <td${localTip}>${escapeHtml(local)}</td>
      <td${remoteTip}>${escapeHtml(remote)}</td>
      <td${tipCellAttr(connStateTip(state, proto))}>${escapeHtml(state)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">No connections in this snapshot</td></tr>`;
  bindTooltips(tbody);
}

async function refreshConnectionsPanel() {
  const meta = $("#connMeta");
  const refreshBtn = $("#connRefresh");
  const tbody = $("#connBody");
  const table = tbody?.closest("table");
  const establishedOnly = !!$("#connEstablishedOnly")?.checked;
  if (meta) meta.textContent = "Loading…";
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  if (table) table.setAttribute("aria-busy", "true");
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const q = establishedOnly ? "?establishedOnly=1" : "";
    const data = await api(`/api/connections/snapshot${q}`);
    renderConnAdapters(data.adapters);
    renderConnRows(data.connections);
    const bits = [];
    if (data.total != null) bits.push(`${data.connections?.length || 0}${data.truncated ? ` of ${data.total}` : ""} rows`);
    if (data.captured_at) bits.push(`captured ${fmtTs(data.captured_at / 1000)}`);
    if (data.warning) bits.push(data.warning);
    if (meta) meta.textContent = bits.join(" · ") || (data.ok ? "Ready" : "Unavailable");
    if (!data.ok && tbody && !(data.connections || []).length) {
      tbody.innerHTML =
        `<tr><td colspan="6" class="muted state-error">${escapeHtml(data.warning || data.error || "Snapshot failed")}</td></tr>`;
    }
  } catch (e) {
    console.error(e);
    if (tbody) {
      tbody.innerHTML =
        `<tr><td colspan="6" class="muted state-error">Load failed: ${escapeHtml(e.message || e)}</td></tr>`;
    }
    if (meta) meta.textContent = "Load failed";
    renderConnAdapters([]);
  } finally {
    if (table) table.removeAttribute("aria-busy");
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function usageAppsFiltered(apps) {
  const q = ($("#usageSearch")?.value || "").trim().toLowerCase();
  let rows = (apps || []).slice();
  if (q) {
    rows = rows.filter((a) => {
      const name = String(a.name || a.display_name || "").toLowerCase();
      const exe = String(a.exe || a.exe_path || "").toLowerCase();
      const key = String(a.app_key || "").toLowerCase();
      return name.includes(q) || exe.includes(q) || key.includes(q);
    });
  }
  const sort = $("#usageSort")?.value || "rate";
  rows.sort((a, b) => {
    if (sort === "name") {
      return String(a.name || a.display_name || "").localeCompare(String(b.name || b.display_name || ""));
    }
    if (sort === "down") return (b.rate_in_mbps || 0) - (a.rate_in_mbps || 0);
    if (sort === "up") return (b.rate_out_mbps || 0) - (a.rate_out_mbps || 0);
    const ar = (a.rate_in_mbps || 0) + (a.rate_out_mbps || 0);
    const br = (b.rate_in_mbps || 0) + (b.rate_out_mbps || 0);
    return br - ar;
  });
  return rows;
}

function renderUsageLiveRows(apps, { controlEnabled = false } = {}) {
  const tbody = $("#usageLiveBody");
  if (!tbody) return;
  const rows = usageAppsFiltered(apps);
  tbody.innerHTML = rows.map((a) => {
    const key = escapeHtml(a.app_key || a.exe || String(a.pid || ""));
    const label = escapeHtml(a.name || a.display_name || a.exe || a.app_key || "?");
    const ignored = !!a.ignored;
    const blocked = !!a.blocked;
    const exe = a.exe || a.exe_path || "";
    let action = "";
    if (!controlEnabled) {
      action = `<span class="muted">Enable network control in Settings</span>`;
    } else if (blocked) {
      action = `<button type="button" class="btn btn-secondary usage-unblock" data-exe="${escapeHtml(exe)}" data-app-key="${key}">Unblock</button>`;
    } else {
      action = `<button type="button" class="btn btn-secondary usage-block" data-exe="${escapeHtml(exe)}" data-app-key="${key}" ${exe ? "" : "disabled"}>Block</button>`;
    }
    return `<tr data-app-key="${key}">
      <td title="${escapeHtml(exe)}">${label}</td>
      <td>${fmtMbps(a.rate_in_mbps)}</td>
      <td>${fmtMbps(a.rate_out_mbps)}</td>
      <td>${fmtBytes(a.bytes_in)}</td>
      <td>${fmtBytes(a.bytes_out)}</td>
      <td><label class="check check-inline"><input type="checkbox" class="usage-ignore" data-app-key="${key}" ${ignored ? "checked" : ""} aria-label="Ignore ${label}" /></label></td>
      <td>${action}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">No active apps with traffic</td></tr>`;
}

function resetUsageTrendChart() {
  if (!usageTrendChart) return;
  try {
    usageTrendChart.destroy();
  } catch {
    /* ignore */
  }
  usageTrendChart = null;
}

function ensureUsageTrend(buckets) {
  const ctx = $("#usageTrendChart");
  const empty = $("#usageTrendEmpty");
  const wrap = ctx?.closest(".chart-wrap");
  const rows = buckets || [];
  if (!ctx) return;
  if (!rows.length) {
    resetUsageTrendChart();
    if (wrap) wrap.classList.add("is-empty");
    if (empty) {
      empty.hidden = false;
      empty.setAttribute("aria-hidden", "false");
    }
    return;
  }
  if (wrap) wrap.classList.remove("is-empty");
  if (empty) {
    empty.hidden = true;
    empty.setAttribute("aria-hidden", "true");
  }
  const byTs = new Map();
  for (const r of rows) {
    const ts = r.bucket_ts;
    if (ts == null) continue;
    const prev = byTs.get(ts) || { in: 0, out: 0 };
    prev.in += Number(r.bytes_in || 0);
    prev.out += Number(r.bytes_out || 0);
    byTs.set(ts, prev);
  }
  const sorted = [...byTs.entries()].sort((a, b) => a[0] - b[0]);
  const labels = sorted.map(([ts]) => fmtTs(ts));
  const down = sorted.map(([, v]) => Math.round(v.in / 1024 / 1024));
  const up = sorted.map(([, v]) => Math.round(v.out / 1024 / 1024));
  const yMax = Math.max(1, ...down, ...up) * 1.15;
  if (usageTrendChart) {
    usageTrendChart.data.labels = labels;
    usageTrendChart.data.datasets[0].data = down;
    usageTrendChart.data.datasets[1].data = up;
    usageTrendChart.options.scales.y.suggestedMax = yMax;
    fitChartToBox(usageTrendChart);
    return;
  }
  usageTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "In (MB)", data: down, borderColor: chartTheme.domain.down, tension: 0.2, pointRadius: 0 },
        { label: "Out (MB)", data: up, borderColor: chartTheme.domain.up, tension: 0.2, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: chartScaleOpts(),
      plugins: { legend: { display: true, position: "bottom" } },
    },
  });
  usageTrendChart.options.scales.y.suggestedMax = yMax;
  fitChartToBox(usageTrendChart);
}

function paintUsageHelperStatus(st) {
  const el = $("#usageHelperStatus");
  const enableBtn = $("#usageEnableBtn");
  if (!el) return;
  if (!st) {
    el.textContent = "";
    el.className = "muted";
    if (enableBtn) enableBtn.hidden = false;
    return;
  }
  if (st.starting) {
    el.textContent = "Starting elevated helper… approve UAC if prompted.";
    el.className = "muted";
    if (enableBtn) enableBtn.disabled = true;
    return;
  }
  if (enableBtn) enableBtn.disabled = false;
  if (st.elevated && st.connected) {
    el.textContent = "Elevated helper connected — per-app usage active.";
    el.className = "muted state-ok";
    if (enableBtn) enableBtn.hidden = true;
  } else if (st.last_error) {
    el.textContent = st.last_error;
    el.className = "muted state-error";
    if (enableBtn) enableBtn.hidden = false;
  } else if (st.usage_monitoring && !st.connected) {
    el.textContent =
      "Usage was enabled before, but the helper is not running. Click Enable and approve UAC to resume (no per-app bytes until then).";
    el.className = "muted";
    if (enableBtn) enableBtn.hidden = false;
  } else if (st.available === false) {
    el.textContent = "Helper binary not found. Build helper/IdtUsageHelper.";
    el.className = "muted state-error";
    if (enableBtn) enableBtn.hidden = true;
  } else {
    el.textContent = "Enable elevated monitoring to see per-app bytes (UAC required).";
    el.className = "muted";
    if (enableBtn) enableBtn.hidden = false;
  }
}

async function refreshUsagePanel() {
  const statusEl = $("#usageHelperStatus");
  const tbody = $("#usageLiveBody");
  const table = tbody?.closest("table");
  const refreshBtn = $("#usageRefresh");
  const enableBtn = $("#usageEnableBtn");
  if (statusEl && !statusEl.textContent) statusEl.textContent = "Loading…";
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="muted">Loading…</td></tr>`;
  if (table) table.setAttribute("aria-busy", "true");
  if (refreshBtn) refreshBtn.disabled = true;
  if (enableBtn) enableBtn.disabled = true;
  try {
    const from = Math.floor(Date.now() / 1000) - 86400;
    const [st, live, hist] = await Promise.all([
      api("/api/usage/status"),
      api("/api/usage/live"),
      api(`/api/usage/history?granularity=hourly&from=${from}`),
    ]);
    paintUsageHelperStatus(st);
    const metaByKey = new Map(
      (hist.apps || []).map((a) => [String(a.app_key), a])
    );
    lastUsageLiveApps = (live.apps || []).map((a) => {
      const meta = metaByKey.get(String(a.app_key));
      return {
        ...a,
        ignored: meta ? !!meta.ignored : !!a.ignored,
        exe_path: a.exe || a.exe_path || (meta && meta.exe_path) || "",
        display_name: a.name || a.display_name || (meta && meta.display_name),
      };
    });
    renderUsageLiveRows(lastUsageLiveApps, {
      controlEnabled: !!st.network_control_enabled,
    });
    ensureUsageTrend(hist.series || hist.buckets || hist.rows || []);
    scheduleChartsResize();
    if (!st.elevated && tbody && !(live.apps || []).length) {
      const err = st.last_error || live.error;
      tbody.innerHTML = err
        ? `<tr><td colspan="7" class="muted state-error">${escapeHtml(err)}</td></tr>`
        : `<tr><td colspan="7" class="muted">Enable elevated monitoring to list per-app traffic.</td></tr>`;
    }
    if (live.error && tbody && !(live.apps || []).length && st.elevated) {
      tbody.innerHTML =
        `<tr><td colspan="7" class="muted state-error">${escapeHtml(live.error)}</td></tr>`;
    }
  } catch (e) {
    console.error(e);
    if (statusEl) {
      statusEl.textContent = e.message || "Failed to load usage";
      statusEl.className = "muted state-error";
    }
    if (tbody) {
      tbody.innerHTML =
        `<tr><td colspan="7" class="muted state-error">Load failed: ${escapeHtml(e.message || e)}</td></tr>`;
    }
    resetUsageTrendChart();
    const empty = $("#usageTrendEmpty");
    if (empty) {
      empty.textContent = "Could not load usage trend.";
      empty.hidden = false;
    }
  } finally {
    if (table) table.removeAttribute("aria-busy");
    if (refreshBtn) refreshBtn.disabled = false;
    if (enableBtn) enableBtn.disabled = false;
  }
}

async function enableUsageMonitoring() {
  const btn = $("#usageEnableBtn");
  if (btn) btn.disabled = true;
  paintUsageHelperStatus({ starting: true });
  try {
    const result = await api("/api/usage/enable");
    if (result && !result.connected) {
      const err =
        result.last_error ||
        "Failed to start IdtUsageHelper (missing resources/helper, UAC cancelled, or pipe timeout).";
      paintUsageHelperStatus({
        available: result.available !== false,
        elevated: false,
        connected: false,
        last_error: err,
      });
      const tbody = $("#usageLiveBody");
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted state-error">${escapeHtml(err)}</td></tr>`;
      }
      return;
    }
    await refreshUsagePanel();
  } catch (e) {
    paintUsageHelperStatus({
      available: true,
      elevated: false,
      last_error: e.message || "Enable failed",
    });
    const tbody = $("#usageLiveBody");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted state-error">${escapeHtml(
        e.message || "Enable failed"
      )}</td></tr>`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function wireUsageLiveActions() {
  const tbody = $("#usageLiveBody");
  if (!tbody || tbody.dataset.wired) return;
  tbody.dataset.wired = "1";
  tbody.addEventListener("change", async (e) => {
    const cb = e.target.closest(".usage-ignore");
    if (!cb) return;
    const appKey = cb.getAttribute("data-app-key");
    try {
      await api("/api/usage/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_key: appKey, ignored: cb.checked }),
      });
    } catch (err) {
      cb.checked = !cb.checked;
      console.error(err);
    }
  });
  tbody.addEventListener("click", async (e) => {
    const blockBtn = e.target.closest(".usage-block");
    const unblockBtn = e.target.closest(".usage-unblock");
    if (!blockBtn && !unblockBtn) return;
    const exe = (blockBtn || unblockBtn).getAttribute("data-exe");
    const appKey = (blockBtn || unblockBtn).getAttribute("data-app-key");
    const name = appKey || exe || "this app";
    if (blockBtn) {
      if (!confirm(`Block network access for ${name}? This adds a firewall rule.`)) return;
      try {
        await api("/api/usage/block", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exe_path: exe, app_key: appKey }),
        });
        await refreshUsagePanel();
      } catch (err) {
        alert(err.message || "Block failed");
      }
    } else {
      try {
        await api("/api/usage/unblock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exe_path: exe, app_key: appKey }),
        });
        await refreshUsagePanel();
      } catch (err) {
        alert(err.message || "Unblock failed");
      }
    }
  });
}

function paintSpeedLast(test) {
  if (!test) {
    $("#speedDown").textContent = "-";
    $("#speedUp").textContent = "-";
    $("#speedPing").textContent = "-";
    $("#speedJitter").textContent = "jitter -";
    $("#speedLoss").textContent = "-";
    $("#speedIsp").textContent = "";
    return;
  }
  $("#speedDown").textContent = fmtMbps(test.download_mbps);
  $("#speedUp").textContent = fmtMbps(test.upload_mbps);
  $("#speedPing").textContent = test.ping_ms != null ? Number(test.ping_ms).toFixed(1) : "-";
  $("#speedJitter").textContent = test.jitter_ms != null ? `jitter ${Number(test.jitter_ms).toFixed(1)} ms` : "jitter -";
  $("#speedLoss").textContent = test.packet_loss != null ? `${Number(test.packet_loss).toFixed(2)}%` : "-";
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
      <td>${t.ping_ms != null ? Number(t.ping_ms).toFixed(1) : "-"}</td>
      <td>${t.jitter_ms != null ? Number(t.jitter_ms).toFixed(1) : "-"}</td>
      <td>${t.packet_loss != null ? Number(t.packet_loss).toFixed(2) + "%" : "-"}</td>
      <td>${escapeHtml(server)}</td>
      <td>${link}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">No speed tests yet</td></tr>`;
}

async function refreshSpeed() {
  const statusEl = $("#speedStatus");
  const runBtn = $("#speedRunBtn");
  const installBtn = $("#speedInstallBtn");
  const tbody = $("#speedHistoryBody");
  const table = tbody?.closest("table");
  const trendWrap = $("#speedTrendChart")?.closest(".chart-wrap");
  const trendEmpty = $("#speedTrendEmpty");

  if (!speedRunning) {
    statusEl.textContent = "Loading…";
    statusEl.className = "muted";
  }
  if (runBtn && !speedRunning) runBtn.disabled = true;
  if (installBtn) installBtn.disabled = true;
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="muted">Loading…</td></tr>`;
  if (table) table.setAttribute("aria-busy", "true");

  try {
    const [st, hist] = await Promise.all([
      api("/api/speedtest/status"),
      api("/api/speedtest/history?limit=50"),
    ]);
    paintSpeedLast(hist.latest);
    renderSpeedHistory(hist.tests || []);
    ensureSpeedTrend(hist.tests || []);
    scheduleChartsResize();
    if (hist && hist.error && tbody && !(hist.tests || []).length) {
      tbody.innerHTML =
        `<tr><td colspan="8" class="muted state-error">History temporarily unavailable: ${escapeHtml(hist.error)}</td></tr>`;
    }
    if (!speedRunning) {
      if (st.available) {
        statusEl.textContent = hist && hist.error
          ? `CLI ready · history sync delayed`
          : `CLI ready${st.path ? ` · ${st.path}` : ""}`;
        statusEl.className = hist && hist.error ? "muted" : "muted state-ok";
      } else {
        statusEl.textContent = st.install_hint || "Speedtest CLI not found";
        statusEl.className = "muted";
      }
    }
    $("#speedRunBtn").disabled = speedRunning || !st.available;
    $("#speedInstallBtn").hidden = !!st.available;
  } catch (e) {
    if (!speedRunning) {
      statusEl.textContent = e.message || "Failed to load speed data";
      statusEl.className = "muted state-error";
    }
    if (tbody) {
      tbody.innerHTML =
        `<tr><td colspan="8" class="muted state-error">Load failed: ${escapeHtml(e.message || e)}</td></tr>`;
    }
    if (speedTrendChart) {
      resetSpeedTrendChart();
    }
    if (trendWrap) trendWrap.classList.add("is-empty");
    if (trendEmpty) {
      trendEmpty.textContent = "Could not load throughput trend.";
      trendEmpty.hidden = false;
      trendEmpty.setAttribute("aria-hidden", "false");
    }
    hideChartTip();
    if (runBtn && !speedRunning) runBtn.disabled = false;
    if (installBtn) installBtn.disabled = false;
  } finally {
    if (table) table.removeAttribute("aria-busy");
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
  statusEl.textContent = "Running Ookla Speedtest... this can take about 20-60 seconds";
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
  if (form.connections_enabled) {
    form.connections_enabled.checked = s.connections_enabled !== false;
  }
  if (form.usage_monitoring) {
    form.usage_monitoring.checked = !!s.usage_monitoring;
  }
  if (form.network_control_enabled) {
    form.network_control_enabled.checked = !!s.network_control_enabled;
  }
  const boolKeys = [
    "lan_devices_enabled",
    "lan_new_device_toast",
    "snmp_enabled",
    "sniffer_enabled",
    "sniffer_always_on",
    "lan_active_discovery",
    "router_webhook_auto_new",
    "influx_enabled",
    "es_enabled",
    "prom_metrics_enabled",
    "http_api_enabled",
  ];
  for (const k of boolKeys) {
    if (form[k]) form[k].checked = k === "lan_devices_enabled" ? s[k] !== false : !!s[k];
  }
  const strKeys = [
    "snmp_community",
    "snmp_targets",
    "notify_webhooks_json",
    "notify_quiet_hours_json",
    "router_webhook_url",
    "router_webhook_template",
    "influx_url",
    "influx_token",
    "influx_org",
    "influx_bucket",
    "es_url",
    "es_api_key",
    "http_api_token",
  ];
  for (const k of strKeys) {
    if (form[k]) form[k].value = s[k] != null ? s[k] : "";
  }
  if (form.lan_discovery_interval_min) {
    form.lan_discovery_interval_min.value = s.lan_discovery_interval_min ?? 15;
  }
  applyUsageCapsAlertsToForm(form, s);
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

const MIB = 1024 * 1024;

function parseUsageJson(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function bytesToMibInput(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.round(n / MIB));
}

function mibInputToBytes(el) {
  if (!el || el.value === "" || el.value == null) return null;
  const n = Number(el.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * MIB);
}

function applyUsageCapsAlertsToForm(form, s) {
  const caps = parseUsageJson(s.usage_caps_json);
  const alerts = parseUsageJson(s.usage_alerts_json);
  if (form.usage_cap_global_daily_mib) {
    form.usage_cap_global_daily_mib.value = bytesToMibInput(caps.global_daily_bytes);
  }
  if (form.usage_cap_global_monthly_mib) {
    form.usage_cap_global_monthly_mib.value = bytesToMibInput(caps.global_monthly_bytes);
  }
  if (form.usage_cap_auto_block) {
    form.usage_cap_auto_block.checked = !!caps.auto_block;
  }
  const apps = caps.apps && typeof caps.apps === "object" ? caps.apps : {};
  const appKeys = Object.keys(apps);
  const appKey = appKeys[0] || "";
  const appSpec = appKey ? apps[appKey] || {} : {};
  if (form.usage_cap_app_key) form.usage_cap_app_key.value = appKey;
  if (form.usage_cap_app_daily_mib) {
    form.usage_cap_app_daily_mib.value = bytesToMibInput(appSpec.daily_bytes);
  }
  if (form.usage_cap_app_exe) form.usage_cap_app_exe.value = appSpec.exe_path || "";
  const rules = Array.isArray(alerts.rules) ? alerts.rules : [];
  const globalRule = rules.find((r) => r && !r.app_key) || null;
  const appRule = rules.find((r) => r && r.app_key) || null;
  if (form.usage_alert_global_daily_mib) {
    form.usage_alert_global_daily_mib.value = bytesToMibInput(globalRule && globalRule.daily_bytes);
  }
  if (form.usage_alert_app_key) {
    form.usage_alert_app_key.value = (appRule && appRule.app_key) || "";
  }
  if (form.usage_alert_app_daily_mib) {
    form.usage_alert_app_daily_mib.value = bytesToMibInput(appRule && appRule.daily_bytes);
  }
}

function buildUsageCapsAlertsFromForm(form) {
  const caps = {};
  const gDay = mibInputToBytes(form.usage_cap_global_daily_mib);
  const gMon = mibInputToBytes(form.usage_cap_global_monthly_mib);
  if (gDay != null) caps.global_daily_bytes = gDay;
  if (gMon != null) caps.global_monthly_bytes = gMon;
  if (form.usage_cap_auto_block && form.usage_cap_auto_block.checked) {
    caps.auto_block = true;
  }
  const appKey = form.usage_cap_app_key ? String(form.usage_cap_app_key.value || "").trim() : "";
  if (appKey) {
    const spec = {};
    const d = mibInputToBytes(form.usage_cap_app_daily_mib);
    if (d != null) spec.daily_bytes = d;
    const exe = form.usage_cap_app_exe ? String(form.usage_cap_app_exe.value || "").trim() : "";
    if (exe) spec.exe_path = exe;
    if (form.usage_cap_auto_block && form.usage_cap_auto_block.checked) {
      spec.auto_block = true;
    }
    caps.apps = { [appKey]: spec };
  }
  const rules = [];
  const alertGlobal = mibInputToBytes(form.usage_alert_global_daily_mib);
  if (alertGlobal != null) {
    rules.push({ id: "global_daily", daily_bytes: alertGlobal, enabled: true });
  }
  const alertAppKey = form.usage_alert_app_key
    ? String(form.usage_alert_app_key.value || "").trim()
    : "";
  const alertAppBytes = mibInputToBytes(form.usage_alert_app_daily_mib);
  if (alertAppKey && alertAppBytes != null) {
    rules.push({
      id: `app_${alertAppKey}`,
      app_key: alertAppKey,
      daily_bytes: alertAppBytes,
      enabled: true,
    });
  }
  return {
    usage_caps_json: caps,
    usage_alerts_json: rules.length ? { rules } : {},
  };
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
      csvBtn.disabled = true;
      csvBtn.setAttribute("aria-busy", "true");
      if (msg) msg.textContent = "Exporting CSV...";
      try {
        const res = await api("/api/export/outages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (msg) msg.textContent = res.path ? `Saved ${res.path}` : "Exported";
      } catch (err) {
        if (msg) msg.textContent = "CSV export failed";
      } finally {
        csvBtn.disabled = false;
        csvBtn.removeAttribute("aria-busy");
      }
    });
  }
  const reportBtn = $("#exportReportBtn");
  if (reportBtn) {
    reportBtn.addEventListener("click", async () => {
      const msg = $("#evidenceMsg");
      reportBtn.disabled = true;
      reportBtn.setAttribute("aria-busy", "true");
      if (msg) msg.textContent = "Opening report...";
      try {
        const res = await api("/api/export/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (msg) msg.textContent = res.path ? "Report opened" : "Report ready";
      } catch (err) {
        if (msg) msg.textContent = "Report failed";
      } finally {
        reportBtn.disabled = false;
        reportBtn.removeAttribute("aria-busy");
      }
    });
  }
  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const usageJson = buildUsageCapsAlertsFromForm(form);
    const body = {
      poll_interval_s: Number(form.poll_interval_s.value),
      debounce_fail_count: Number(form.debounce_fail_count.value),
      probe_retention_days: Number(form.probe_retention_days.value),
      autostart: form.autostart.checked,
      toast_alerts: form.toast_alerts.checked,
      minimize_to_tray: form.minimize_to_tray
        ? form.minimize_to_tray.checked
        : true,
      connections_enabled: form.connections_enabled
        ? form.connections_enabled.checked
        : true,
      usage_monitoring: form.usage_monitoring
        ? form.usage_monitoring.checked
        : false,
      network_control_enabled: form.network_control_enabled
        ? form.network_control_enabled.checked
        : false,
      lan_devices_enabled: form.lan_devices_enabled
        ? form.lan_devices_enabled.checked
        : true,
      lan_new_device_toast: !!(form.lan_new_device_toast && form.lan_new_device_toast.checked),
      snmp_enabled: !!(form.snmp_enabled && form.snmp_enabled.checked),
      snmp_community: form.snmp_community ? form.snmp_community.value.trim() : "public",
      snmp_targets: form.snmp_targets ? form.snmp_targets.value.trim() : "",
      sniffer_enabled: !!(form.sniffer_enabled && form.sniffer_enabled.checked),
      sniffer_always_on: !!(form.sniffer_always_on && form.sniffer_always_on.checked),
      lan_active_discovery: !!(form.lan_active_discovery && form.lan_active_discovery.checked),
      lan_discovery_interval_min: form.lan_discovery_interval_min
        ? Number(form.lan_discovery_interval_min.value)
        : 15,
      notify_webhooks_json: form.notify_webhooks_json
        ? form.notify_webhooks_json.value.trim() || "[]"
        : "[]",
      notify_quiet_hours_json: form.notify_quiet_hours_json
        ? form.notify_quiet_hours_json.value.trim() || "{}"
        : "{}",
      router_webhook_url: form.router_webhook_url ? form.router_webhook_url.value.trim() : "",
      router_webhook_template: form.router_webhook_template
        ? form.router_webhook_template.value.trim()
        : "",
      router_webhook_auto_new: !!(form.router_webhook_auto_new && form.router_webhook_auto_new.checked),
      influx_enabled: !!(form.influx_enabled && form.influx_enabled.checked),
      influx_url: form.influx_url ? form.influx_url.value.trim() : "",
      influx_token: form.influx_token ? form.influx_token.value.trim() : "",
      influx_org: form.influx_org ? form.influx_org.value.trim() : "",
      influx_bucket: form.influx_bucket ? form.influx_bucket.value.trim() : "",
      es_enabled: !!(form.es_enabled && form.es_enabled.checked),
      es_url: form.es_url ? form.es_url.value.trim() : "",
      es_api_key: form.es_api_key ? form.es_api_key.value.trim() : "",
      prom_metrics_enabled: !!(form.prom_metrics_enabled && form.prom_metrics_enabled.checked),
      http_api_enabled: !!(form.http_api_enabled && form.http_api_enabled.checked),
      http_api_token: form.http_api_token ? form.http_api_token.value.trim() : "",
      usage_caps_json: usageJson.usage_caps_json,
      usage_alerts_json: usageJson.usage_alerts_json,
      wan_targets: form.wan_targets.value.trim(),
      dns_resolver: form.dns_resolver.value.trim(),
      http_url: form.http_url.value.trim(),
    };
    try {
      const saved = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await api("/api/monitor/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !!form.paused.checked }),
      });
      if (form.autostart) form.autostart.checked = !!saved.autostart;
      const hint = $("#autostartHint");
      if (body.autostart && !saved.autostart) {
        $("#settingsMsg").textContent = "Saved, but Start with Windows failed. Try the Setup installer";
        if (hint) {
          hint.textContent =
            "Could not register at sign-in. Run the Setup installer, or keep the portable .exe in a fixed folder and try again.";
        }
      } else if (saved.autostart && saved.autostart_path) {
        $("#settingsMsg").textContent = "Saved";
        if (hint) {
          hint.textContent = `Starts at sign-in from: ${saved.autostart_path}`;
        }
      } else {
        $("#settingsMsg").textContent = "Saved";
      }
      setTimeout(() => { $("#settingsMsg").textContent = ""; }, 4000);
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
  setupConnectionsPanel();
  setupTipDismiss();
  setupTooltips();
  setupChartResize();
  defaultHistoryRange();
  defaultSystemLogsRange();
  document.querySelectorAll("[data-goto-tab]").forEach((el) => {
    el.addEventListener("click", () => activateTab(el.getAttribute("data-goto-tab"), { focusPanel: true }));
  });
  if (window.idt && typeof window.idt.onStatusUpdate === "function") {
    window.idt.onStatusUpdate((s) => paintStatus(s));
  }
  if (window.idt && typeof window.idt.onLayout === "function") {
    window.idt.onLayout(() => scheduleChartsResize());
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

/* --- Tooltips (Emil skip-delay after first open) --- */

const tipController = {
  el: null,
  anchor: null,
  openTimer: null,
  skipDelay: false,
  delayMs: 380,
};

function ensureTipEl() {
  if (tipController.el) return tipController.el;
  const el = document.createElement("div");
  el.className = "ui-tooltip";
  el.setAttribute("role", "tooltip");
  el.id = "uiTooltip";
  el.hidden = true;
  document.body.appendChild(el);
  tipController.el = el;
  return el;
}

function tipPayload(anchor) {
  if (!anchor) return null;
  if (anchor.dataset.tipText) {
    return { name: null, meaning: anchor.dataset.tipText };
  }
  const key = anchor.dataset.tip;
  if (key && LAYER_TIPS[key]) return LAYER_TIPS[key];
  return null;
}

function positionTip(anchor) {
  const tip = ensureTipEl();
  const r = anchor.getBoundingClientRect();
  tip.style.visibility = "hidden";
  tip.classList.add("is-open");
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.visibility = "";
}

function showTip(anchor) {
  const payload = tipPayload(anchor);
  if (!payload) return;
  const tip = ensureTipEl();
  tip.hidden = false;
  tip.innerHTML = payload.name
    ? `<span class="tip-name">${escapeHtml(payload.name)}</span><span class="tip-body">${escapeHtml(payload.meaning)}</span>`
    : `<span class="tip-body">${escapeHtml(payload.meaning)}</span>`;
  tipController.anchor = anchor;
  anchor.setAttribute("aria-describedby", tip.id);
  positionTip(anchor);
  tip.classList.add("is-open");
  tipController.skipDelay = true;
}

function hideTip() {
  if (tipController.openTimer) {
    clearTimeout(tipController.openTimer);
    tipController.openTimer = null;
  }
  const tip = tipController.el;
  if (tip) {
    tip.classList.remove("is-open");
    tip.hidden = true;
  }
  if (tipController.anchor) {
    tipController.anchor.removeAttribute("aria-describedby");
    tipController.anchor = null;
  }
}

function scheduleTip(anchor) {
  if (tipController.openTimer) clearTimeout(tipController.openTimer);
  const delay = tipController.skipDelay ? 0 : tipController.delayMs;
  tipController.openTimer = setTimeout(() => showTip(anchor), delay);
}

function bindTooltips(root = document) {
  root.querySelectorAll(".has-tip").forEach((el) => {
    if (el.dataset.tipBound) return;
    el.dataset.tipBound = "1";
    el.addEventListener("pointerenter", () => scheduleTip(el));
    el.addEventListener("pointerleave", () => hideTip());
    el.addEventListener("focus", () => scheduleTip(el));
    el.addEventListener("blur", () => hideTip());
  });
}

function setupTooltips() {
  bindTooltips(document);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
  window.addEventListener("scroll", () => hideTip(), true);
}

function setupTipDismiss() {
  const tip = $("#firstRunTip");
  const btn = $("#dismissTip");
  if (!tip) return;
  try {
    if (localStorage.getItem("idt-tip-dismissed") === "1") {
      tip.hidden = true;
      tip.classList.add("is-dismissed");
    }
  } catch (_) { /* ignore */ }
  if (btn) {
    btn.addEventListener("click", () => {
      tip.hidden = true;
      tip.classList.add("is-dismissed");
      try {
        localStorage.setItem("idt-tip-dismissed", "1");
      } catch (_) { /* ignore */ }
    });
  }
}
