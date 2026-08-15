# Cross-verify: peer-gaps POST-IMPL re-CV (grok45 isolated)

**Date:** 2026-08-12  
**Reviewer:** grok45 (`cursor-grok-4.5-high`)  
**Claims attacked:** prior FAIL merge `docs/reviews/CV_peer-gaps-impl_2026-08-12.md` BLOCKING + listed extras; spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`  
**Scope:** live code only; no other `CV_peer-gaps-impl_2026-08-12_re_*`; no product edits; no rebuild/relaunch  
**Open BLOCKING:** 1  
**Gate:** CLEAR_FORBIDDEN  
**Verdict:** **FAIL** — Overview 30d wiring incomplete (`db.summary` still session-clocked).

## Per-reviewer counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok45 | 1 | 0 | 1 | 0 |

## Claimed-fixed checklist

| # | Claim | Live verdict | Evidence |
|---|-------|--------------|----------|
| 1 | `observeSince` = MIN(first probe, first outage), not session `started_at` | **FAIL (BLOCKING)** | `main.js:529-535`: computes `observeSince = observationStart({ firstProbeAt, firstOutageAt })` then **`db.summary(null, { observeSince: monitor.state.started_at })`**. Response `observe_since` + `honestUptimeBar(..., { firstProbeAt, firstOutageAt })` use history; summary/streak path does not. Export `api:export:report` (`main.js:658-659`) still `monitor.state.started_at`. |
| 2 | `connections.snapshot` `trackDelta` default false; `api:connections:snapshot` passes true | **PASS** | `connections.js:474` `!!opts.trackDelta`; `main.js:753-757` `trackDelta: true`; sidecars `lan-bridge.js:34-37,234-237` `trackDelta: false` / `trackAdapters: false`. |
| 3 | `lan_devices_enabled=false` blocks ping/traceroute before spawn | **PASS** | `lan-devices.js:527-550`: `lanDevicesEnabled()` → `devicesDisabledProbe` **before** `pingHost` / `tracerouteHost`. Test `lan-devices.test.js:481-496`. |
| 4 | `http_cert_days` retained when HTTP skipped | **PASS** | `monitor.js:425-430`: update only if `result.http_cert_days != null`; else clear only when `lan_ok && wan_ok && dnsOk` (HTTP ran / was eligible). Test `monitor.test.js:330-338`. |
| — | `tracerouteHost` private-before-`execFile` | **PASS** | `traceroute.js:69-88`: `tracerouteTargetAllowed` → reject before `execFileAsync`. |
| — | `_tick` isolation | **PASS** | `monitor.js` requires only `netcheck` + `uptime-bar`; `_tick` has no lan/connections/snmp/sniffer/traceroute/IPC names (grep clean). |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-APP-001 | product | internet-downtime-tracker | BLOCKING | Honest observation clock: `api:summary` must pass MIN(firstProbe, firstOutage) into `db.summary` / not leave session `started_at` as `observeSince` | `electron/main.js:529-535`; contrast `534` vs `535`; `658-659` | product:internet-downtime-tracker | open | grok45 |
| CV-APP-001b | product | internet-downtime-tracker | MEDIUM | Export report summary still session-capped via `started_at` | `electron/main.js:658-659` | product:internet-downtime-tracker | open | grok45 |

### CV-APP-001 — BLOCKING (incomplete fix)

**claim:** Observation history clock = MIN(first probe timestamp, first outage `started_at`), not `monitor.state.started_at`.

**evidence:** Partial ship. Lines 529–534 correctly derive history clocks and `observeSince`. Line 535 ignores that value and still feeds `monitor.state.started_at` into `db.summary`. `uptime_bar.pct_label` can still look honest via `firstProbeAt`/`firstOutageAt` (`541-545`, `uptime-bar.js:13-20,107`), so a shallow UI check can false-PASS while the named `observeSince` contract remains broken for streak/summary consumers.

**attack:** Prior FAIL acceptance was “not session `started_at`.” Live summary call still is. Prefer FAIL over CLEAR_OK.

**fix:** `db.summary(null, { observeSince })` using the MIN-derived value (or `null` so `summary` falls back to `MIN(probes)`). Align export report the same way. Keep `honestUptimeBar` history args.

## Process note (not re-opened as BLOCKING)

Spec L5 no longer stamps Done/`CLEAR_OK`; still says FAIL / CLEAR_FORBIDDEN until product fixes — consistent with this re-CV. Prior `CV-PROCESS-001` false-READY schism is closed.

## Prior BLOCKING not re-opened

| id | Status |
|----|--------|
| CV-APP-002 | fixed (default-off delta + IPC opt-in) |
| CV-APP-003 | fixed (devices-off before spawn) |
| CV-PROCESS-001 | fixed (spec no longer forges CLEAR_OK) |

Prior HIGH test gaps (CV-TEST-001..005) not re-audited as BLOCKING this pass.

## Disagreements

None (isolated reviewer).

## Art routing

None.

## Return contract

- **Path:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_re_grok45.md`
- **Open BLOCKING:** 1 (`CV-APP-001`)
- **Gate:** `CLEAR_FORBIDDEN`
- **Counts:** BLOCKING 1 · HIGH 0 · MEDIUM 1 · LOW 0
