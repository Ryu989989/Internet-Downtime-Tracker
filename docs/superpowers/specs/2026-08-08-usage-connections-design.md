# Usage + Connections design (2026-08-08)

Phased A→B→C behind one dashboard surface. Electron stays **non-elevated by default**. Never couple sockets/usage into `monitor._tick`.

## Privilege model

| Surface | Elevation | Honest claim |
|---------|-----------|--------------|
| **Connections** | None | Live TCP/UDP + adapter RX/TX rates. **No** per-app bytes / billing. |
| **Usage** | Separate elevated .NET ETW helper (UAC on opt-in) | Task Manager–grade per-app bytes while helper runs. |
| **Control** | Firewall rules via elevated path; master toggle default **off** | Block/unblock by exe path; caps/alerts. No WinDivert/throttle. |

Degraded UX: Connections always works; Usage shows “Enable elevated monitoring” when helper is off.

## Phase 1 — Connections

- Tab between System logs and Speed; lead disclaimer; Refresh; Established-only; optional 30–60s auto-refresh **only while tab visible**.
- Strip: adapter name + RX/TX Mbps (`Get-NetAdapterStatistics` deltas).
- Table: Proto · Process · PID · Local · Remote · State (cap ~200).
- Backend: `electron/connections.js` (PowerShell, ≤8–10s timeout); IPC `api:connections:snapshot`; lazy on `activateTab("connections")`.
- Settings: `connections_enabled` default **on**.
- No new sql.js tables.

## Phase 2 — Usage (ETW helper)

- Helper: .NET 8+ + TraceEvent, named pipe `\\.\pipe\IdtUsageHelper-<token>`, auth token file under userData.
- Electron: `usage-bridge.js` ↔ helper; sql.js `usage_apps`, `usage_hourly`, `usage_daily`; prune hourly 14d / daily 90d (separate from probe retention).
- UI: segmented **Connections | Usage**; live top apps, session totals, Chart.js history, search/sort/ignore; Clear usage history.
- Settings opt-in `usage_monitoring` (default off) triggers UAC helper start.
- Suppress/mark samples during Ookla (`setProbeSuppress` remains independent).

## Phase 3 — Control

- Alerts: daily byte thresholds → tray toast (cooldown).
- Caps: daily/monthly per-app or global; notify; optional auto-block.
- Block/Unblock: Firewall rule by exe path; confirm dialog; reversible.
- Settings: `network_control_enabled` master toggle (default **off**).

## Out of scope

WinDivert / bandwidth throttle, packet capture / SNI / geo scoring, always-on service without Usage opt-in, elevating the whole Electron app, Overview hero live Mbps.

## Integration rules

1. No usage/connection work in `monitor._tick`.
2. Dedicated IPC + tab-visible polling only (not `status:update`).
3. Pause/mark usage during speed tests.
4. Update CSP / preload allowlist / security tests for new channels.
5. Reuse `.tabs`, `.pill`, `.table-wrap`, `.stats`, tokens.
6. README capability matrix + privilege requirements.

## Schema (Phase 2+)

```sql
usage_apps(app_key TEXT PK, display_name, exe_path, ignored INTEGER)
usage_hourly(app_key, bucket_ts, bytes_in, bytes_out, PRIMARY KEY(app_key, bucket_ts))
usage_daily(app_key, bucket_ts, bytes_in, bytes_out, PRIMARY KEY(app_key, bucket_ts))
usage_alert_state(rule_key TEXT PK, last_fired_at REAL)  -- Phase 3 cooldowns
```

Settings keys: `connections_enabled`, `usage_monitoring`, `network_control_enabled`, `usage_caps_json`, `usage_alerts_json`.

## Verify / Ship

Per-phase adversarial checks (probe isolation, privilege honesty, sql.js amplification, privacy, YAGNI). Final `/mega-review` → `docs/reviews/MEGA_REVIEW_*`; **Ship only on PASS with no open Criticals**.
