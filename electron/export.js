"use strict";

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtIso(ts) {
  if (ts == null) return "";
  return new Date(Number(ts) * 1000).toISOString();
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return "";
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function uptimePct(downtimePct) {
  const d = Number(downtimePct) || 0;
  return Math.round((100 - d) * 1000) / 1000;
}

function outagesToCsv(outages, { now = Date.now() / 1000 } = {}) {
  const header = [
    "id",
    "type",
    "started_at",
    "ended_at",
    "duration_ms",
    "duration",
    "notes",
    "open",
  ];
  const lines = [header.join(",")];
  for (const o of outages || []) {
    const open = o.ended_at == null;
    const dur =
      o.duration_ms != null
        ? o.duration_ms
        : Math.max(0, Math.floor((now - o.started_at) * 1000));
    lines.push(
      [
        o.id,
        o.type,
        fmtIso(o.started_at),
        open ? "" : fmtIso(o.ended_at),
        dur,
        fmtDuration(dur),
        o.notes || "",
        open ? "1" : "0",
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function speedTestsToCsv(tests) {
  const header = [
    "id",
    "tested_at",
    "download_mbps",
    "upload_mbps",
    "ping_ms",
    "jitter_ms",
    "packet_loss",
    "isp",
    "server_name",
    "server_location",
    "result_url",
  ];
  const lines = [header.join(",")];
  for (const t of tests || []) {
    lines.push(
      [
        t.id,
        fmtIso(t.tested_at),
        t.download_mbps,
        t.upload_mbps,
        t.ping_ms,
        t.jitter_ms,
        t.packet_loss,
        t.isp,
        t.server_name,
        t.server_location,
        t.result_url,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function buildEvidenceCsv({ outages = [], speedTests = [], now = Date.now() / 1000 } = {}) {
  return (
    "# outages\r\n" +
    outagesToCsv(outages, { now }) +
    "\r\n# speed_tests\r\n" +
    speedTestsToCsv(speedTests)
  );
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function windowRow(name, win) {
  const all = win?.all || {};
  const bits = ["lan", "wan", "dns", "http"]
    .map((k) => {
      const w = win?.[k] || {};
      return `${k.toUpperCase()}: ${w.count || 0} · ${fmtDuration(w.downtime_ms || 0)}`;
    })
    .join(" · ");
  return `<tr>
    <td>${escHtml(name)}</td>
    <td>${uptimePct(all.downtime_pct)}%</td>
    <td>${fmtDuration(all.downtime_ms || 0)}</td>
    <td>${all.count || 0}</td>
    <td class="muted">${escHtml(bits)}</td>
  </tr>`;
}

function buildHtmlReport({
  summary,
  outages = [],
  generatedAt = new Date(),
  now = Date.now() / 1000,
} = {}) {
  const sum = summary || { windows: {}, longest: [], provider: null };
  const provider = sum.provider;
  const longest = (sum.longest || []).slice(0, 8);
  const recent = (outages || []).slice(0, 40);
  const windows = sum.windows || {};

  const outageRows = recent
    .map((o) => {
      const open = o.ended_at == null;
      const dur =
        o.duration_ms != null
          ? o.duration_ms
          : Math.max(0, Math.floor((now - o.started_at) * 1000));
      return `<tr>
        <td class="type-${escHtml(o.type)}">${escHtml(String(o.type || "").toUpperCase())}</td>
        <td>${escHtml(fmtIso(o.started_at))}</td>
        <td>${open ? "ongoing" : escHtml(fmtIso(o.ended_at))}</td>
        <td>${escHtml(fmtDuration(dur))}${open ? "…" : ""}</td>
        <td>${escHtml(o.notes || "")}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Internet Downtime Tracker — Evidence Report</title>
  <style>
    :root { color-scheme: light dark; --bg:#0f1419; --fg:#e7eef6; --muted:#8b9bb0; --border:#2c3a4a; --elev:#1a222c;
      --lan:#f07178; --wan:#e6b450; --dns:#5b9fd4; --http:#3ecf8e; }
    @media (prefers-color-scheme: light) {
      :root { --bg:#f4f7fb; --fg:#15202b; --muted:#5a6b7d; --border:#d0d8e2; --elev:#fff; }
    }
    body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg); }
    h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
    h2 { font-size: 1rem; margin: 1.5rem 0 0.6rem; }
    .muted { color: var(--muted); }
    .card { background: var(--elev); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.45rem 0.55rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .type-lan { color: var(--lan); font-weight: 650; }
    .type-wan { color: var(--wan); font-weight: 650; }
    .type-dns { color: var(--dns); font-weight: 650; }
    .type-http { color: var(--http); font-weight: 650; }
    @media print { body { background: #fff; color: #111; } .card { border-color: #ccc; } }
  </style>
</head>
<body>
  <h1>Internet Downtime Tracker — Evidence Report</h1>
  <p class="muted">Generated ${escHtml(generatedAt.toISOString())}. Local monitoring only while the app is running.</p>

  <div class="card">
    <h2>Provider</h2>
    ${
      provider
        ? `<p><strong>${escHtml(provider.isp || "Unknown ISP")}</strong><br/>
           <span class="muted">${escHtml(
             [provider.server_name, provider.server_location].filter(Boolean).join(" · ") || "—"
           )}</span>
           ${provider.ping_ms != null ? `<br/>Ping ${escHtml(Number(provider.ping_ms).toFixed(1))} ms` : ""}
           </p>`
        : `<p class="muted">No speed test on file yet.</p>`
    }
  </div>

  <div class="card">
    <h2>Uptime summary</h2>
    <table>
      <thead><tr><th>Window</th><th>Uptime</th><th>Downtime</th><th>Events</th><th>By domain</th></tr></thead>
      <tbody>
        ${windowRow("24h", windows["24h"])}
        ${windowRow("7d", windows["7d"])}
        ${windowRow("30d", windows["30d"])}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Longest outages (30d)</h2>
    <table>
      <thead><tr><th>Type</th><th>Started</th><th>Duration</th><th>Notes</th></tr></thead>
      <tbody>
        ${
          longest
            .map((o) => {
              const dur =
                o.duration_ms != null
                  ? o.duration_ms
                  : Math.max(0, Math.floor((now - o.started_at) * 1000));
              return `<tr>
                <td class="type-${escHtml(o.type)}">${escHtml(String(o.type || "").toUpperCase())}</td>
                <td>${escHtml(fmtIso(o.started_at))}</td>
                <td>${escHtml(fmtDuration(dur))}</td>
                <td>${escHtml(o.notes || "")}</td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="4" class="muted">None</td></tr>`
        }
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Recent outages</h2>
    <table>
      <thead><tr><th>Type</th><th>Started</th><th>Ended</th><th>Duration</th><th>Notes</th></tr></thead>
      <tbody>
        ${outageRows || `<tr><td colspan="5" class="muted">None</td></tr>`}
      </tbody>
    </table>
  </div>
  <p class="muted">Tip: use your browser’s Print → Save as PDF for a shareable ISP evidence file.</p>
</body>
</html>`;
}

module.exports = {
  csvEscape,
  outagesToCsv,
  speedTestsToCsv,
  buildEvidenceCsv,
  buildHtmlReport,
  fmtDuration,
  uptimePct,
};
