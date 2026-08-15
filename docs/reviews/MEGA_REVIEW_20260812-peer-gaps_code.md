# MEGA_REVIEW 20260812 peer-gaps — code-reviewer

**Scope:** Wave 2–3 vs `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md` (tooltips, connections rDNS/port/service/delta, devices category/NBT/ping/traceroute/ports, overview certDays + honest 30d, topology click-select/pan-zoom/LLDP, IPC, `monitor._applyProbe` `http_cert_days` without `_tick` coupling).  
**CV:** `docs/reviews/CV_peer-gaps-plan_2026-08-12.md` (FAIL; BLOCKING expected in product).  
**Graphify:** missing (`graphify-out/graph.json` absent) — continued.  
**Not run:** `npm test` (test-engineer lane); electron-builder; relaunch.

**Verdict: FAIL** — 0 Critical, 2 High.

Locked skips **not** filed: GeoIP, Close Connection, sent/recv, WinDivert, public status page, RDP/shutdown, Ask-to-connect, `fail_reason` via `_tick`, labeling 14d probes as 30d.

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Correctness | 6 | 30d % vs session-age label; Connections delta shared with Topology/Sniffer snapshots |
| Security | 8 | Ping/traceroute gated `isPrivateOrLocalIp`; `execFile`; UI `escapeHtml` |
| Architecture | 7 | `connections.snapshot()` has global delta/adapter side effects |
| Tests | 7 | Strong unit coverage; no monitor `http_cert_days` copy; no delta isolation |
| Performance | 8 | rDNS cap 8; NBT cap 8; service CIM once |

## Top fix first

Stop treating every `connections.snapshot()` as a Connections-tab delta cycle. Topology (`lan-bridge.js` ~229) and sniffer `fetchFlows` (~33) call `snapshot({ establishedOnly: true })`, which runs `applySnapshotDelta` and overwrites `lastConnRows`. With sniffer on (2s) or after a Topology refresh, the Connections tab’s new/dropped/state-changed highlight is wrong (Listen rows look “new”; dropped rows leak into sniffer flows for one poll).

## CV BLOCKING (product)

| ID | Status |
|----|--------|
| CV-APP-001 honest 30d | **Partial** — spark never labeled 30d; `%` from `windows["30d"]`; **label clock is session start** (High below) |
| CV-APP-002 `checkHttp` 3-tuple + cert | **Done** — same-response `getPeerCertificate`; HTTP → `null` not `0`; parent copies in `_applyProbe` |
| CV-APP-003 traceroute | **Done** — `electron/traceroute.js`; on-demand IPC; not netcheck / not `_tick` |
| CV-PROCESS-001 `app.js` ownership | Process (not scored) |

`_tick` still only probe / prune / adapter / quality burst. Grep tests in `lan-security.test.js` + `security.test.js` cover new channels + `monitor.js` source.

## Findings

### Critical

None.

### High

1. **`electron/main.js:529-539` + `electron/db.js:1221-1230` — 30d bar label uses monitor session, not observation history.**  
   `api:summary` sets `observeSince = monitor.state.started_at`. `summary()` already loads `firstProbe` and **drops it**. `honestUptimeBar` then labels `<1d`/`Nd` after every restart while `windows["30d"]` still uses a 30-day outage lookback and 30-day denominator. Spark captions stay honest; the **stat/bar % is 30d math wearing a session-age sticker**. After a restart, “1d observed · 2% down” is easy to read as 2% of one day.  
   **Fix:** Pass observation start = `MIN(first outage.started_at, firstProbe.t)` (outages are not pruned). Keep spark labeled `24h` / `probe_retention_days`. Do not bump retention. Add a test that a 40d-old first outage + 1h `started_at` still yields `pct_label === "30d"`.

2. **`electron/connections.js:445-464` + `electron/lan-bridge.js:33,229` — delta (and adapter sample) is process-global.**  
   Spec: new/changed/dropped highlight **one cycle** on the Connections snapshot. `applySnapshotDelta` always runs. Sniffer poll (2s) and Topology refresh use established-only snapshots, so `lastConnRows` becomes that subset. Next Connections paint marks Listen/non-established as `new` and can append `dropped` ghosts into sniffer `flows` for one poll (close events delayed). Tests only call `snapshot()` in isolation.  
   **Fix:** `snapshot({ trackDelta: false, trackAdapters: false })` for sidecar callers; only the Connections IPC path tracks delta. Test: sidecar snapshot must not change the next UI snapshot’s `delta` fields.

### Medium

3. **`electron/monitor.js:425` + `electron/netcheck.js:484-504` — `http_cert_days` wiped when HTTP is not probed.**  
   `probe()` leaves `http_cert_days: null` if LAN/WAN/DNS skip `checkHttp`. `_applyProbe` always assigns that null. HTTPS `http_url` users lose cert days on any lower-layer fail (chip → `N/A`). HTTP default URL still shows `N/A (HTTP URL)` so default path looks fine.  
   **Fix:** Copy cert only when HTTP ran (`http_ok != null` after a `checkHttp` call), or omit the field vs `null`. Distinguish “HTTP URL / no cert” from “not probed”. Test `_applyProbe` retains prior days when `lan_ok` is false.

4. **`web/app.js:3146-3158` vs spec NetWorx Yes — adapter chips omit session bytes.**  
   `computeAdapterRates` already returns `rx_bytes`/`tx_bytes`. Chips/tips only show Mbps; `conn-adapter-mbps` copy says “`-` until a second sample”. Spec: session-origin bytes + rate, or label “since last refresh”.  
   **Fix:** Show `fmtBytes(rx_bytes/tx_bytes)` on chip/tip; if `rx_mbps == null`, say “since last refresh” / first sample.

5. **`electron/lan-devices.js:318-320,457-467` — hostname source + “passive cache” disclaimer are memory-only.**  
   `hostname_source` is not stored in DB. `hadActiveHostnameLookups()` is `hostnameCache.size > 0`. After restart (or `listDevices` before a lookup pass), named rows tip as `source none` and meta can say “Passive neighbor cache” even when hostnames came from NBT/PTR.  
   **Fix:** Persist `hostname_source` on upsert, or treat non-empty DB hostname as last known source; disclaimer follows stored source not cache size.

6. **`electron/test/monitor.test.js` — no `http_cert_days` copy assertion.**  
   `makeResult()` omits the field. Netcheck/uptime-bar tests cover parse/format; parent wiring (CV-APP-002) is untested. Removing line 425 would still pass the suite.  
   **Fix:** `_applyProbe({ ..., http_cert_days: 12 })` then `snapshot().http_cert_days === 12`.

7. **`electron/test/ui.test.js` — no contracts for cert chip, 30d bar, Devices ping/traceroute, resolve-DNS checkbox.**  
   Topology click/pan-zoom strings are grepped; Overview/Devices/Connections new surfaces are not.  
   **Fix:** Assert `httpCertChip`, `uptimeBar30`, `device-ping`/`device-traceroute`, `connResolveDns`, `connections_resolve_dns` default off.

### Low

8. **`web/app.js:230-242` vs `electron/uptime-bar.js:35-47` — duplicated `formatHttpCertDays`.** Drift risk (renderer cannot require `uptime-bar`). Keep one copy in comments or a shared snippet test that both match.

9. **`electron/connections.js:429-437` — rDNS timeout stores `null` forever.** Test locks this (`connections.test.js:247`). 500ms timeout + no TTL means a slow DNS name never retries this session. Optional: TTL or don’t cache misses.

10. **`electron/lan-devices.js:688-693` — neighbor-mode warning omits “not a switch fabric”.** Gateway star is honest (no fake mesh). LLDP stubs already say it (`snmp-topology.js:164`). Add the same phrase on neighbor mode.

11. **Settings privilege — Win32_Service / NBT emptiness.** `set-connections` covers `?` names and no sent/recv; `conn-service` is “empty if none”; `set-lan-devices` mentions PTR/NBT but not “may be empty unelevated”. Add one clause; do not claim TCPView-complete (already avoided).

## What’s done well

- `checkHttp` 3-tuple is optional-safe; HTTP never yields `0`; cert from the same `https:` response; `_tick` control flow unchanged; copy lives in `_applyProbe`.
- Traceroute is a new module with hop cap/timeout; Devices IPC private-IP gated; ping wraps `pingHost`.
- Connections: resolve default **off**, local well-known ports, one CIM `Win32_Service` map, 1-cycle delta **when snapshot is isolated**, XSS escaped.
- Devices: OUI category, NBT then PTR after ARP (not in `snapshot()`), `getLatestScanForIp`, disabled state mirrors Connections warning, disclaimer drops “passive cache” when lookups ran **this process**.
- Topology: click node ↔ row, selected label + collision avoid, pan/zoom with reduced-motion = buttons only, LLDP sysName→IP + unpolled stubs + public IP drop; tests use sysName `to` vs IP-keyed layout.
- Preload allowlist matches `safeHandle` for ping/traceroute; `connections_resolve_dns` in `BOOL_SETTINGS` default false.
- Usage new-exe toast on first INSERT + existing `toast_alerts`; no `first_seen` column.
- Layer tips use live snapshot fields only; `lastFailReason` is always null.

## Verification story

| Claim | Status | Evidence |
|-------|--------|----------|
| Tests reviewed | **verified** | traceroute, netcheck certDays, uptime-bar, connections enrichment, lan-devices category/NBT/scan/ping, snmp LLDP, lan-security `_tick` grep |
| `npm test` | **not run** | specialist constraint; test-engineer lane |
| Debounce / WAN-while-LAN | **assumed unchanged** | `_applyProbe` still drives `_updateLayer`; no new `_tick` callers |
| No `_tick` LAN/traceroute coupling | **verified** (source + tests) | `monitor.js` has no `tracerouteHost` / lan-devices require; security greps |
| No second HTTP fetch from `_tick` | **verified** | cert via `certDaysFromSocket` on existing response |
| `probe_retention_days` not bumped | **verified** | `DEFAULT_SETTINGS` still 14 |
| Packaged rebuild / relaunch | **not run** | instructed skip |
| Graphify blast radius | **failed** (missing graph) | continued without it |
| XSS on new tables | **verified** | `escapeHtml` on conn/device/topo interpolations |
| Ping/traceroute SSRF | **verified** | `isPrivateOrLocalIp` before `pingHost` / `tracerouteHost` |

## Ship

**FAIL / Do not ship** — Highs 1–2 before merge. BLOCKING cert + traceroute land; honest-30d label clock and Connections delta isolation do not.

MEGA_REVIEW_STATUS: FAIL  
Counts: Critical 0 · High 2 · Medium 5 · Low 4
