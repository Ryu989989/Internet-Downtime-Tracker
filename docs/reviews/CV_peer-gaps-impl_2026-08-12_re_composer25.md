# Cross-verify: peer-gaps POST-IMPL re-run (composer25 isolated)

**Date:** 2026-08-12  
**Claims attacked:** Prior merge `docs/reviews/CV_peer-gaps-impl_2026-08-12.md` (4 open BLOCKING); spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`  
**Reviewer:** composer25 (`composer-2.5`) — isolated re-CV 3/3 after product fixes  
**Scope:** Live-code verification of claimed BLOCKING fixes only. No product edits, no rebuild/relaunch, no other `CV_peer-gaps-impl_2026-08-12_re_*` inputs.  
**Open BLOCKING:** 0  
**Gate:** CLEAR_OK

## Per-reviewer counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| composer25 | 0 | 0 | 1 | 0 |

## Prior BLOCKING — verification

| id | claim | verdict | evidence |
|----|-------|---------|----------|
| CV-PROCESS-001 | Spec stamps `CLEAR_OK` while mega/CV FAIL | **fixed** | Spec L5: `Status: FAIL until product fixes land`; no `CLEAR_OK` stamp |
| CV-APP-001 | `observeSince` = MIN(first probe, first outage), not session `started_at` | **fixed** | `electron/main.js:529-545` computes `observationStart({ firstProbeAt, firstOutageAt })`, returns `observe_since`; `honestUptimeBar` uses `firstProbeAt`/`firstOutageAt` for `pct_label`; `electron/test/uptime-bar.test.js:46-55` 40d outage + 1h session → `"30d"` |
| CV-APP-002 | `snapshot` delta isolated; only Connections IPC tracks | **fixed** | `electron/connections.js:474-475` default `trackDelta`/`trackAdapters` false; `electron/main.js:753-758` `api:connections:snapshot` passes `true`; `electron/lan-bridge.js:34-37,234-237` sidecars pass `false`; `electron/test/connections.test.js:343-371` sidecar does not poison UI delta |
| CV-APP-003 | `lan_devices_enabled=false` blocks ping/traceroute before spawn | **fixed** | `electron/lan-devices.js:527-550` `lanDevicesEnabled()` guard before `pingHost`/`tracerouteHost`; `electron/test/lan-devices.test.js:481-496` asserts no spawn when disabled |
| CV-APP-004 (was HIGH) | `http_cert_days` retained when HTTP skipped (lower-layer down) | **fixed** | `electron/monitor.js:425-430` retains unless all lower layers up; `electron/test/monitor.test.js:330-341` LAN-down retains 12, full-path null clears |

## Additional scoped checks

| topic | verdict | evidence |
|-------|---------|----------|
| `tracerouteHost` private-before-`execFile` | **fixed** (was MEDIUM) | `electron/traceroute.js:69-88` `tracerouteTargetAllowed` → reject before `execFileAsync` at :94 |
| `_tick` isolation | **fixed** (product Hold closed) | `electron/monitor.js:3-9,364-406` requires only `netcheck` + `uptime-bar`; `_tick` = probe/prune/adapter/quality only; `electron/test/lan-security.test.js:34-56` greps forbid LAN/connections/traceroute/ping IPC in `monitor.js` |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-APP-001-R | product | internet-downtime-tracker | MEDIUM | `db.summary` streak still session-scoped via `observeSince: monitor.state.started_at` while 30d label uses history | `electron/main.js:535` passes `monitor.state.started_at` to `db.summary`; label path uses `uptime_bar.pct_label` from history clocks | product:internet-downtime-tracker | open | composer25 |

**CV-APP-001-R note:** Not BLOCKING — prior attack was forged **30d label** (`pct_label`); that contract is satisfied. Residual: `uptime_streak_s` in `api:summary` remains session-capped. Accept or align streak to `observe_since` in a follow-up.

## Disagreements

None (isolated single reviewer).

## Claims that held (re-verified)

- `observationStart` MIN over `firstProbeAt`/`firstOutageAt`; UI prefers `uptime_bar.pct_label` (`web/app.js:1783-1788`).
- Sidecar `connections.snapshot({ establishedOnly: true, trackDelta: false, trackAdapters: false })` does not mutate `lastConnRows`/`lastAdapterSample`.
- Ping/traceroute IPC routes to `pingDevice`/`tracerouteDevice` with settings guard; public IPs still rejected.
- `probe()` returns `http_cert_days: null` when LAN/WAN/DNS skip HTTP (`electron/netcheck.js:486-504`); monitor retains prior days on skip.
- `tracerouteHost` rejects non-private targets before subprocess spawn.
- `monitor._tick` has no `lan-devices`, `connections`, `traceroute`, `checkHttp`, or new LAN IPC strings.

## Art routing

None.

## Return contract

- **Path:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_re_composer25.md`
- **Open BLOCKING:** 0
- **Gate:** `CLEAR_OK` (product BLOCKING fixes verified in live code; prior HIGH/test gaps from merged CV not re-audited this pass)
