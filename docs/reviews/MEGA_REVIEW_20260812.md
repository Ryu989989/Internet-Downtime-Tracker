# MEGA_REVIEW_20260812 — peer-gaps info pass (merged)

**Scope:** Wave 2–3 vs `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md` (tooltips, connections rDNS/port/service/delta, devices category/NBT/ping/traceroute/ports, overview certDays + honest 30d, topology click-select/pan-zoom/LLDP, IPC, `monitor._applyProbe` `http_cert_days` without `_tick` coupling).  
**Date:** 2026-08-12  
**Inputs:** `MEGA_REVIEW_20260812-peer-gaps_code.md` (FAIL, H2) · `_security.md` (PASS, M1) · `_test.md` (FAIL, H5)  
**CV:** `docs/reviews/CV_peer-gaps-plan_2026-08-12.md` (FAIL; BLOCKING expected in product).  
**Graphify:** missing (`graphify-out/graph.json` absent) — continued.  
**CI:** `npm test` → **135/135 pass**, exit 0, 854ms (test-engineer). electron-builder / relaunch **not run**.  
**Union rule:** worst severity wins; High/Medium not dropped. Overall FAIL if any specialist FAIL or any High/Critical remains.

**Locked skips (not findings):** GeoIP, Close Connection, sent/recv, WinDivert, public status page, RDP/shutdown, Ask-to-connect, `fail_reason` via `_tick`, labeling 14d probes as 30d.

## Verdict

**FAIL / Do not ship** — 0 Critical · **7 High** · 9 Medium · 6 Low · 2 Info.

| Specialist | Verdict | C | H | M | L | I |
|------------|---------|---|---|---|---|---|
| code-reviewer | FAIL | 0 | 2 | 5 | 4 | 0 |
| security-auditor | PASS | 0 | 0 | 1 | 2 | 2 |
| test-engineer | FAIL | 0 | 5 | 6 | 3 | 0 |
| **merged** | **FAIL** | **0** | **7** | **9** | **6** | **2** |

Merges (worst wins): code M6 → **H4**; test M11 → **H5**; security Low `tracerouteHost` private guard → **M7**; code M7 ∪ test M10 → **M9**.

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Correctness | 6 | 30d % vs session-age label; Connections delta shared with Topology/Sniffer |
| Security (IPC / spawn / XSS) | 8 | Ping/traceroute IPC ignores `lan_devices_enabled` |
| Isolation (`_tick`) | 6 | Product holds; greps miss spec module list |
| Architecture | 7 | `connections.snapshot()` has global delta/adapter side effects |
| Testing | 5 | No `probe().http_cert_days`; no retention/prune lock; thin UI contracts |
| Performance | 8 | rDNS/NBT cap 8; traceroute in-flight uncapped |
| Privilege honesty | 9 | Electron asInvoker; CIM/NBT emptiness weakly documented |
| Bind / Electron lockdown | 10 | `loadFile` + CSP; metrics/API `127.0.0.1` |

**Overall:** 6/10

## Top fix first

**H1 — stop labeling 30d math with a session-age clock.** `api:summary` sets `observeSince = monitor.state.started_at` while `windows["30d"]` uses a 30-day outage lookback. After restart, “1d observed · 2% down” reads as 2% of one day. Pass `MIN(first outage.started_at, firstProbe.t)` (outages are not pruned). Keep spark `24h` / `probe_retention_days`. Do not bump retention.

Then H2 (delta isolation) before merge; H3–H7 in the same test pass (≤10 new tests if grouped).

## CV BLOCKING (product)

| ID | Status |
|----|--------|
| CV-APP-001 honest 30d | **Partial** — spark never labeled 30d; `%` from `windows["30d"]`; **label clock is session start** (**H1**) |
| CV-APP-002 `checkHttp` 3-tuple + cert | **Done in product** — same-response `getPeerCertificate`; HTTP → `null` not `0`; parent copies in `_applyProbe`. **Tests incomplete** (**H3**, **H4**, **M1**, **M8**) |
| CV-APP-003 traceroute | **Done in product** — `electron/traceroute.js`; on-demand IPC; not netcheck / not `_tick`. Wrapper-only private guard (**M7**) |
| CV-PROCESS-001 `app.js` ownership | Process (not scored) |

`_tick` still only probe / prune / adapter / quality burst.

## Findings

### Critical

None. Debounce, WAN-while-LAN-down, and HTTP API token tests exist and were not weakened.

### High

1. **`electron/main.js:529-539` + `electron/db.js:1221-1230` — 30d bar label uses monitor session, not observation history.** *(code H1)*  
   `summary()` already loads `firstProbe` and **drops it**. `honestUptimeBar` then labels `<1d`/`Nd` after every restart while `windows["30d"]` still uses a 30-day outage lookback and 30-day denominator. Spark captions stay honest; the **stat/bar % is 30d math wearing a session-age sticker**.  
   **Fix:** Observation start = `MIN(first outage.started_at, firstProbe.t)`. Keep spark labeled `24h` / `probe_retention_days`. Do not bump retention. Test: 40d-old first outage + 1h `started_at` still yields `pct_label === "30d"`.

2. **`electron/connections.js:445-464` + `electron/lan-bridge.js:33,229` — delta (and adapter sample) is process-global.** *(code H2)*  
   Spec: new/changed/dropped highlight **one cycle** on the Connections snapshot. `applySnapshotDelta` always runs. Sniffer poll (2s) and Topology refresh use established-only snapshots, so `lastConnRows` becomes that subset. Next Connections paint marks Listen/non-established as `new` and can append `dropped` ghosts into sniffer `flows` for one poll. Tests only call `snapshot()` in isolation.  
   **Fix:** `snapshot({ trackDelta: false, trackAdapters: false })` for sidecar callers; only the Connections IPC path tracks delta. Test: sidecar snapshot must not change the next UI snapshot’s `delta` fields.

3. **`probe().http_cert_days` and layered HTTP skip untested** — `electron/test/netcheck.test.js` (no `probe` import); `electron/netcheck.js:486-504`. *(test H1)*  
   Spec Wave-2 contract is `checkHttp` 3-tuple **and** `probe().http_cert_days`. A 2-tuple destructure in `probe()` silently zeros cert. LAN-down still calling `checkHttp` for cert would break probe isolation / extra `_tick` network. Neither regression fails CI.  
   **Fix:** One test: LAN-down → `http_ok` false, `http_cert_days` null, `checkHttp` not invoked; HTTPS `httpUrl` → numeric `http_cert_days` from one request.

4. **Monitor never asserts `http_cert_days` copy into state/snapshot** — `electron/test/monitor.test.js:12-22,281-289`; `electron/monitor.js:222,243,425`. *(test H2 ∪ code M6)*  
   Parent-owned snapshot field can drop without failing tests; Overview pills stay empty. `makeResult()` omits the field. Removing line 425 would still pass the suite.  
   **Fix:** `_applyProbe`/`processResult` with `http_cert_days: 12` → `state` + `snapshot().http_cert_days === 12`; omit/`null` stays `null`. Do not change `_tick` control flow in the test double.

5. **`_tick` isolation greps miss the spec module list** — `electron/test/lan-security.test.js:24-41`; `electron/test/security.test.js:273-288`. *(test H3 ∪ test M11)*  
   Adding `require("./snmp-topology")` / `./connections` / `./usage-bridge` / `./packet-sniffer` / `./port-scan` to `monitor.js` does not fail CI. `main.js` `_tick[\s\S]{0,80|120}` never matches real coupling (`_tick` lives in `monitor.js`). New channel names **are** grepped (good).  
   **Fix:** Grep `monitor.js` (and keep channel names) for `usage-bridge`, `connections`, `snmp-topology`, `packet-sniffer`, `port-scan` / `tracerouteHost` (already). Drop or replace the adjacency regex on `main.js`.

6. **Data-loss: no lock that retention stays 14d or that prune cannot delete outages** — `electron/db.js:19,927-935`; no hits in `electron/test/**` for `probe_retention_days` / `pruneProbes`. *(test H4)*  
   Spec: do not raise `probe_retention_days`; outages are **not** pruned (30d % is outage overlap). Bumping default to 30 rewrites the full sql.js DB every prune. `DELETE FROM outages` inside `pruneProbes` would wipe history and forge 0% downtime. Usage prune is tested (`pruneUsage`); probe/outage prune is not.  
   **Fix:** `assert.equal(DEFAULT_SETTINGS.probe_retention_days, 14)`; insert outage + old probe → `pruneProbes()` deletes probe only.

7. **Devices disabled UI warning untested** — payload: `lan-devices.test.js:411-416`; UI: `web/app.js:2257-2271`. `ui.test.js` only greps `refreshDevicesPanel` (`:73`). *(test H5)*  
   Spec: show `data.warning` when `lan_devices_enabled=false` (Connections pattern). Backend can be correct while UI returns to “0 devices”.  
   **Fix:** `ui.test.js` grep `paintDevicesDisabled`, `data.warning`, `devicesDisabledBanner` / `state-error`.

### Medium

1. **`electron/monitor.js:425` + `electron/netcheck.js:484-504` — `http_cert_days` wiped when HTTP is not probed.** *(code M3)*  
   `probe()` leaves `http_cert_days: null` if LAN/WAN/DNS skip `checkHttp`. `_applyProbe` always assigns that null. HTTPS `http_url` users lose cert days on any lower-layer fail (chip → `N/A`). HTTP default URL still shows `N/A (HTTP URL)`.  
   **Fix:** Copy cert only when HTTP ran (`http_ok != null` after a `checkHttp` call), or omit the field vs `null`. Distinguish “HTTP URL / no cert” from “not probed”. Test `_applyProbe` retains prior days when `lan_ok` is false.

2. **`web/app.js:3146-3158` vs spec NetWorx Yes — adapter chips omit session bytes.** *(code M4)*  
   `computeAdapterRates` already returns `rx_bytes`/`tx_bytes`. Chips/tips only show Mbps; `conn-adapter-mbps` copy says “`-` until a second sample”. Spec: session-origin bytes + rate, or label “since last refresh”.  
   **Fix:** Show `fmtBytes(rx_bytes/tx_bytes)` on chip/tip; if `rx_mbps == null`, say “since last refresh” / first sample.

3. **`electron/lan-devices.js:318-320,457-467` — hostname source + “passive cache” disclaimer are memory-only.** *(code M5)*  
   `hostname_source` is not stored in DB. `hadActiveHostnameLookups()` is `hostnameCache.size > 0`. After restart (or `listDevices` before a lookup pass), named rows tip as `source none` and meta can say “Passive neighbor cache” even when hostnames came from NBT/PTR.  
   **Fix:** Persist `hostname_source` on upsert, or treat non-empty DB hostname as last known source; disclaimer follows stored source not cache size.

4. **Ping/traceroute IPC ignores Devices master switch** — CWE-285 / OWASP A01. *(security M)*  
   **Location:** `electron/main.js:861-866`; `electron/lan-devices.js:476-493`; contrast `electron/lan-bridge.js:67-71`, `148-151`.  
   `lan_devices_enabled=false` stops ARP/NBT/PTR and paints the Connections-style warning. The new channels still spawn `ping`/`tracert` for any `isPrivateOrLocalIp` target. UI hides buttons; DevTools or XSS in the sandboxed renderer can still ICMP/traceroute the LAN.  
   **Fix:** In both handlers (or in `pingDevice`/`tracerouteDevice`), if `lan_devices_enabled === false`, return `devicesDisabledPayload()` and do not spawn. Unit test: disabled settings short-circuit before `pingHost`/`tracerouteHost`.

5. **`connections_resolve_dns` default false not asserted on settings** — `electron/db.js:27`; `electron/test/usage-db.test.js:103-108` defaults omit this key. *(test M6)*  
   Behavioral skip when `snapshot()` omits `resolveDns` is covered (`connections.test.js:218-220`). IPC uses `!!settings.connections_resolve_dns` (`electron/main.js:749`).  
   **Fix:** `getSettings().connections_resolve_dns === false` next to other safe defaults.

6. **Honest 30d: null / `<1d` / 30.0d unlabeled** — `electron/uptime-bar.js:23-24` (`pctWindowLabel`: `days == null` → `"30d"`); tests only 10.2d and 40d (`uptime-bar.test.js:13-44`). *(test M7; pairs with H1)*  
   UI fallback `observedWindowLabel` treats null as `"Observed"` (`web/app.js:1767-1772`) but `paintUptimeBar30` prefers `uptime_bar.pct_label` (`:1784-1788`).  
   **Fix:** Assert null/`firstProbeAt` path is not `"30d"` unless observed ≥ 30; add `<1d` and 30.0d.

7. **`tracerouteHost` not private-only; no private success for `tracerouteDevice`** — CWE-78 defense-in-depth. *(test M8 ∪ security L)*  
   **Location:** `electron/traceroute.js:67-71` (guard only in `tracerouteDevice` `:490-492`). Production IPC is wrapped. A future caller of `tracerouteHost` can `execFile` `tracert` against a public host (DNS disabled via `-d`, still outbound ICMP). `tracerouteDevice` public reject is tested (`lan-devices.test.js:460-462`); private success + `MAX_HOPS` wiring are not.  
   **Fix:** Call `isPrivateOrLocalIp` inside `tracerouteHost` before `execFile` **or** test that every IPC path goes through `tracerouteDevice`; add private-IP success with mocked `tracert`.

8. **“No second HTTP from `_tick` / same-response cert” not locked** — HTTPS test (`netcheck.test.js:112-134`) does not count requests. `monitor.js` has no grep that `_tick`/`_runProbe` does not call `checkHttp` twice. *(test M9)*  
   **Fix:** Count `https` requests in the cert fixture; grep `monitor.js` for `checkHttp`/`https.request` (expect none — probe owns it).

9. **UI contracts for new Overview/Devices/Connections/Usage surfaces missing** — `electron/test/ui.test.js`. *(code M7 ∪ test M10)*  
   Topology click/pan-zoom strings are grepped; Overview/Devices/Connections new surfaces are not. Only three header greps: `hist-type`, `topo-nb`, `topo-conns` (`ui.test.js:37,88-89`).  
   **Fix:** Assert `httpCertChip`, `uptimeBar30`, `device-ping`/`device-traceroute`, `connResolveDns`; grep `wireChartTip(usageTrendChart`; assert `data-tip="dev-cat"`, `conn-service`, `stat-30d`, `http-cert`, and Devices/Connections/Usage `<th scope="col" … data-tip`.

### Low

1. **`web/app.js:230-242` vs `electron/uptime-bar.js:35-47` — duplicated `formatHttpCertDays`.** Drift risk (renderer cannot require `uptime-bar`). HTTPS `0` / bad URL not covered (HTTP `0` → `N/A (HTTP URL)` is). Keep one copy in comments or a shared snippet test that both match. *(code L8 ∪ test L13)*

2. **`electron/connections.js:429-437` — rDNS timeout stores `null` forever.** Test locks this (`connections.test.js:247`). 500ms timeout + no TTL means a slow DNS name never retries this session. Optional: TTL or don’t cache misses. *(code L9)*

3. **`electron/lan-devices.js:688-693` — neighbor-mode warning omits “not a switch fabric”.** Gateway star is honest (no fake mesh). LLDP stubs already say it (`snmp-topology.js:164`). Add the same phrase on neighbor mode. *(code L10)*

4. **Settings privilege — Win32_Service / NBT emptiness.** `set-connections` covers `?` names and no sent/recv; `conn-service` is “empty if none”; `set-lan-devices` mentions PTR/NBT but not “may be empty unelevated”. Add one clause; do not claim TCPView-complete (already avoided). *(code L11)*

5. **No in-flight cap on traceroute IPC** — CWE-400. `electron/traceroute.js:77-80` (`timeout: 30_000`); `electron/main.js:864-866`. Repeated `lanDevicesTraceroute` can stack many 30s `tracert` processes. Ping is shorter but also uncapped. **Fix:** Single-flight mutex or reject if a traceroute is already running. *(security L)*

6. **IPv6 public traceroute untested.** `isPrivateOrLocalIp` allows `fc`/`fd`/`fe80` (`port-scan.js:29-31`); traceroute tests are IPv4-only. *(test L14)*

### Info

- **Private allowlist includes loopback and `169.254.0.0/16`** (`electron/port-scan.js:24-38`). `127.0.0.1` / `localhost` / `169.254.169.254` are valid Devices targets. ICMP/NBT is not HTTP IMDS; still wider than “LAN neighbor row” if XSS supplies the IP. Optional: deny loopback + `169.254.169.254` (and IPv6 `::1`) on ping/traceroute. *(security I)*
- **Connections PTR of public remotes (by design).** Opt-in, settings-driven, IP-only PTR, default `connections_resolve_dns: false`, renderer cannot override. Names `escapeHtml`’d. No fix required. *(security I)*

## Coverage matrix (named review targets)

| Target | Status | Evidence |
|--------|--------|----------|
| `checkHttp` 3-tuple / certDays | **Partial** | HTTP → `null` + HTTPS days: `netcheck.test.js:85-135`. Timeout 3-tuple: `export.test.js:50-57`. **No** `probe()` import; **no** request-count for same-response / no second fetch. |
| Uptime-bar honest labels | **Partial** | 40d → `pct_label "30d"`, spark `"14d"`/`"24h"` not 30d: `uptime-bar.test.js:13-32`. 10.2d → `"10d"`: `:35-44`. **No** null `observeSince`, `<1d`, exactly 30d. Product label clock is session start (**H1**). |
| Connections delta / rDNS off-by-default | **Partial** | Cap/cache/timeout + 1-cycle delta in isolation: `connections.test.js:196-321`. **No** sidecar-isolation test (**H2**). **No** `getSettings().connections_resolve_dns === false`. |
| lan-devices category / hostname / enabled warning | **Partial** | OUI, NBT then PTR, public skip, `devicesDisabledPayload`: `lan-devices.test.js:343-446`. **No** `paintDevicesDisabled` / `data.warning` UI grep. Hostname source not persisted (**M3**). |
| traceroute private-only | **Partial** | `tracerouteDevice({ip:"8.8.8.8"})` rejects. Parse + hop cap + not in netcheck. **`tracerouteHost` itself has no private guard**; ping/traceroute IPC not gated on `lan_devices_enabled` (**M4**). |
| SNMP LLDP mapping | **Covered** | sysName + IP → IP-keyed layout, stubs + warning, drop `8.8.8.8`: `snmp-topology.test.js:29-118`. |
| `_tick` coupling greps | **Partial** | `tracerouteHost` / `pingDevice` / new channels / lan-devices\|lan-bridge. **Missing** usage-bridge, connections, snmp-topology, sniffer, scan. |
| `ui.test` data-tip headers | **Partial** | Only `hist-type`, `topo-nb`, `topo-conns`. New-pass surfaces unasserted (**M9**, **H7**). |

**Already green (do not re-ask):** debounce open-after-2 / close-on-success / WAN suppressed while LAN down — `monitor.test.js:40-72`, `security.test.js:204-217`. HTTP API 401 without token — `lan-security.test.js:64-91`.

## Attack checklist (security)

| Attack | Result |
|--------|--------|
| Privilege honesty (non-elevated default; Usage helper required) | **Hold** |
| Ping / traceroute / rDNS / NetBIOS not on `monitor._tick` | **Hold** (product); greps incomplete (**H5**) |
| Private/local IP guards (ping, traceroute, NBT/PTR) | **Hold** (public rejected on wrapper) |
| IPC allowlist (preload ↔ `safeHandle`, sender check) | **Hold** |
| Traceroute spawn args (no `shell:true`, host last, `-d`/`-n`) | **Hold** |
| Reverse-DNS SSRF / leak | **Hold** (opt-in, settings-driven, IP-only PTR) |
| LAN devices disabled path | **Partial** — UI/list/refresh honest; ping/traceroute IPC not gated (**M4**); UI warning untested (**H7**) |
| Public bind forbidden | **Hold** |

## What’s done well

- `checkHttp` 3-tuple optional-safe; HTTP never yields `0`; cert from the same `https:` response; `_tick` control flow unchanged; copy lives in `_applyProbe`.
- Traceroute is a new module (`execFile`, hop cap/timeout); Devices IPC public-IP gated; ping wraps `pingHost`.
- Connections: resolve default **off**, local well-known ports, one CIM `Win32_Service` map, XSS escaped.
- Devices: OUI category, NBT then PTR after ARP (not in `snapshot()`), `getLatestScanForIp` parameterized SQL, disabled list/refresh uses warning not “0 devices”.
- Topology: click node ↔ row, selected label + collision avoid, pan/zoom with reduced-motion = buttons only, LLDP sysName→IP + unpolled stubs + public IP drop.
- Electron prefs: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; dashboard `loadFile` only; preload allowlist 1:1 with `safeHandle`; `connections_resolve_dns` in `BOOL_SETTINGS` default false.
- Usage new-exe toast on first INSERT + existing `toast_alerts`; no `first_seen` column.
- Layer tips use live snapshot fields only; `lastFailReason` is always null.
- Privilege: no `requestedExecutionLevel`; Usage still UAC helper. Bind: `BIND_HOST === "127.0.0.1"`; CSP `connect-src 'none'`.
- `npm test` 135/135 including new `uptime-bar` / `traceroute` / `snmp-topology`. `fail_reason` absence locked.

## Missing money / auth / data-loss / probe-isolation

| Class | Present | Missing (this pass) |
|-------|---------|---------------------|
| **Money / billing honesty** | Usage cap/alert tests; honest 14d spark ≠ 30d | Retention default 14; 30d label when `observeSince` null; **H1** session clock |
| **Auth** | HTTP API Bearer 401/200; helper token-file | `connections_resolve_dns` default false on `getSettings()` |
| **Data-loss** | `encodeSnapshotJson` size; persist-failure queries; usage `pruneUsage` | **`pruneProbes` vs `outages`**; probe retention bump |
| **Probe isolation** | Debounce; WAN while LAN down; DNS/HTTP need lower layers; new channels not in `monitor.js`; `tracerouteDevice` public reject; SNMP public seed | **`probe()` not called from tests**; incomplete module greps; second HTTP; `tracerouteHost` public |

## Next CV wave — Highs (product + tests)

1. **H1** Honest 30d: observation clock = history, not `started_at` (`main.js` + `db.js`)
2. **H2** `snapshot({ trackDelta:false })` for Topology/sniffer; Connections-only delta
3. **H3** `probe().http_cert_days` + LAN-down skip `checkHttp`
4. **H4** `_applyProbe` copies `http_cert_days` onto snapshot
5. **H5** `monitor.js` greps for usage-bridge / connections / snmp-topology / sniffer / scan
6. **H6** `probe_retention_days === 14` + `pruneProbes` does not delete outages
7. **H7** Devices disabled UI shows `data.warning` (`paintDevicesDisabled`)

Land **M1–M9** in the same pass (cert retain, adapter bytes, hostname_source, ping/traceroute `lan_devices_enabled` gate, rDNS default, 30d edge labels, `tracerouteHost` private, second-HTTP lock, UI contracts).

## Fable-judge claims

| Claim | Status | Evidence |
|-------|--------|----------|
| `npm test` 135 pass, exit 0 | **verified** | test-engineer: repo root; `tests 135` / `pass 135` / `fail 0` / exit 0 |
| Debounce open-after-N / close-on-success | **verified** | `electron/test/monitor.test.js:40-58` present and passing |
| WAN suppressed while LAN down | **verified** | `monitor.test.js:60-72`; `security.test.js:204-217` |
| No `_tick` LAN/traceroute coupling (product) | **verified** | `monitor.js` requires only netcheck + uptime-bar; no `tracerouteHost` / lan-devices require |
| Spec `monitor.js` greps cover full module list | **failed** | Only traceroute/lan-devices/lan-bridge/new channels; not usage-bridge/connections/snmp-topology/sniffer/scan (**H5**) |
| Spec `probe().http_cert_days` tested | **failed** | no `probe()` call in `electron/test`; `netcheck.test.js` does not import `probe` (**H3**) |
| Monitor copies `http_cert_days` into snapshot | **failed** (untested) | product line 425 exists; `makeResult()` omits field (**H4**) |
| `probe_retention_days` default 14 locked | **failed** | No test mentions `probe_retention_days`; source still 14 (**assumed** product / **failed** test) |
| `pruneProbes` does not delete outages | **failed** (untested) | impl deletes `probes` only (`db.js:933`) — **assumed** product, **unverified** by tests (**H6**) |
| Honest 30d label clock = observation history | **failed** | `observeSince = monitor.state.started_at` (**H1**) |
| Connections delta isolated from Topology/sniffer | **failed** | `applySnapshotDelta` always runs (**H2**) |
| No second HTTP fetch from `_tick` | **verified** (source) / **failed** (test lock) | cert via `certDaysFromSocket` on existing response; request-count untested (**M8**) |
| Devices-disabled UI warning | **verified** (payload) / **failed** (UI test) | `devicesDisabledPayload` + `paintDevicesDisabled`; `ui.test.js` does not grep it (**H7**) |
| Devices-disabled blocks ping/traceroute IPC | **failed** | Medium **M4** |
| Private IP guards on Devices ping/traceroute | **verified** | `isPrivateOrLocalIp`; tests reject `1.1.1.1` / `8.8.8.8` |
| `tracerouteHost` itself private-only | **failed** | guard only in `tracerouteDevice` (**M7**) |
| IPC allowlist 1:1 + sender check | **verified** | `preload.js` / `registerIpc` / `safeHandle` |
| Traceroute spawn safe | **verified** | `execFile` + `-d`/`-n` + numeric hops/wait |
| rDNS not SSRF; default off; not renderer-overridable | **verified** (function) / **assumed** (settings default) | `resolveDns: !!settings.connections_resolve_dns`; settings default untested (**M5**) |
| XSS on new tables | **verified** | `escapeHtml` / `tipCellAttr`; traceroute hops `textContent` |
| No public bind | **verified** | `loadFile`; `BIND_HOST`; listen tests in `lan-security.test.js` |
| No `requestedExecutionLevel`; Electron unelevated | **verified** | Product grep empty; Usage helper `Start-Process -Verb RunAs` only |
| Usage helper still required | **verified** | `main.js` `api:usage:enable` → `startElevated`; README matrix |
| LLDP sysName vs IP layout | **verified** | `snmp-topology.test.js:29-72` |
| ui.test locks new data-tip headers | **failed** | Only `hist-type`, `topo-nb`, `topo-conns` (**M9**) |
| `probe_retention_days` not bumped (source) | **verified** | `DEFAULT_SETTINGS` still 14 |
| Packaged rebuild / relaunch | **not run** | instructed skip |
| Graphify blast radius | **failed** (missing graph) | continued without it |

## Ship

**FAIL / Do not ship.** Highs H1–H7 before merge. BLOCKING cert + traceroute land in product; honest-30d label clock, Connections delta isolation, and spec-required test locks do not.

Do not stamp `mega-review.ok` on this FAIL.

MEGA_REVIEW_STATUS: FAIL  
Counts: Critical 0 · High 7 · Medium 9 · Low 6 · Info 2
