# MEGA_REVIEW_20260828 — Wi-Fi drop diagnostics (merged)

**Scope:** Wave 1–2 vs `docs/superpowers/specs/2026-08-28-wifi-drop-diagnostics.md`.  
**Date:** 2026-08-28  
**Initial range:** `5271d43` (`origin/master`) → `be74a4e`  
**Follow-up:** `6490c72` (High/Medium product fixes) · `c392486` (test assertion fixes)  
**Inputs:** `MEGA_REVIEW_20260828-wifi-drop_code.md` (FAIL, H2) · `_security.md` (PASS) · `_test.md` (FAIL, H5)  
**Graphify:** missing — continued.  
**CI:** `npm test` → **278/280 pass**, 2 fail (pre-existing Linux runner: `connections.test.js` Win32_Service CIM; `speedtest.test.js` Windows path traversal). This-pass files pass. electron-builder / relaunch not run.

**Union rule:** worst severity wins. Overall FAIL if any specialist FAIL or any High/Critical remains **on current HEAD**.

**Locked skips (not findings):** heatmaps, monitor mode, Npcap, `%→dBm` conversion, fake SNR, `wlanreport` HTML, Native WLAN helper, `wifi` outage type, WAN-while-LAN-down, roaming-aggressiveness writes, widget SSID, CoreWLAN/`wdutil`, retention bump.

## Verdict

**PASS / ship** on current HEAD (`c392486`) after follow-up. Initial review was **FAIL** (0 Critical · **7 High**). Follow-up cleared every High.

| Specialist | Initial | After follow-up |
|------------|---------|-----------------|
| code-reviewer | FAIL 0C 2H | Highs fixed |
| security-auditor | PASS 0C 0H 0M 1L | Low nearby stacking fixed |
| test-engineer | FAIL 0C 5H | Highs locked in tests |
| **merged (HEAD)** | **FAIL** | **PASS** — 0C · 0H · 0M open |

## Scorecard (HEAD)

| Dimension | /10 | Top residual |
|-----------|-----|----------------|
| Correctness | 9 | Host-nic alerts sample this PC only; History trusts snapshot on closed rows |
| Security (IPC / spawn / XSS) | 9 | Nearby coalesced; Event Log `events[]` stripped from UI IPC |
| Isolation (`_tick`) | 10 | `monitor.js` greps hold; nearby / Event Log not on host-nic timer |
| Architecture | 9 | Chronicle/nearby stay off parent tick |
| Testing | 8 | Competing verdict matrix, ingest debounce, no-`wifi`-type, host-nic alert filter |
| Performance | 8 | Events capped at 500; ingest `skipCache` |
| Privilege honesty | 9 | asInvoker; empty nearby/Event Log still honest |
| Bind / Electron lockdown | 10 | Unchanged sandbox + CSP |

**Overall:** 9/10

## Top fix first (done)

1. Host-nic tick evaluates **only** `hostNicAlertSamples()`; `syncRouterPoll` off clears leftover router RSSI (`clearRouterWifiCache`).
2. History `api:outages` live-computes `wifiVerdictForOutage` only when `ended_at == null`.
3. Tests lock competing `correlateVerdict`, ingest debounce, `openOutage("wifi")` throw, History snapshot-only grep.

## Findings — initial (pre-fix)

### Critical

None.

### High (all addressed in `6490c72` / `c392486`)

1. **Host-nic timer re-evaluated stale router RSSI** — `lan-bridge.js` `startHostNicPoll` → `checkWifiAlerts`. **Fix:** subset samples + clear router cache when poll stops.
2. **History recomputed verdict from live WAN/peers for closed rows** — `main.js` `api:outages`. **Fix:** open LAN only.
3–7. Test lane: competing verdict matrix; ingest path; live verdict wiring; no `wifi` outage type; host-nic `checkWifiAlerts` grep. **Fix:** tests listed above.

### Medium (addressed unless noted)

- Signal `dBm` no longer stored as `%`; RSSI `%` does not become `rssi`.
- `scanWindowsLogs` caps `events` at 500; ingest uses `skipCache`; UI IPC omits `events`.
- Host-nic tick rebuilds `lastWifiMetrics`; poll keeps host_nic rows.
- Nearby single-flight + Scan button disable; `iw` iface allowlist; stderr cap.
- SSID roam compare is case-insensitive; debounce stamp after successful ingest; numeric Reason prefers message text.
- Compact `.adapter-line .meta-chip` CSS restored.

### Low / Info remaining

None blocking. Optional: chronicle vs `system-logs.classifyEvent` id drift (12013 roam-if-bssid vs connect) is intentional and documented in the code review Info.

## Grep gates (HEAD)

`electron/monitor.js` does not match: `Get-WinEvent`, `system-logs`, `wifi-chronicle`, `wifi-nearby`, `iw scan`, `show networks`, `lan-bridge`, `wlanreport`.  
WAN still skipped while LAN down (`probe()`). No `type === "wifi"` outage insert (`OUTAGE_TYPES` lan/wan/dns/http). No Overview `rssiToPct`.

## Plan checklist

| Requirement | Status |
|-------------|--------|
| No `wifi` outage type | Pass + test lock |
| WAN skipped while LAN down | Unchanged (locked skip) |
| Windows RSSI null unless dBm | Pass; dBm Signal not shown as `%` |
| Host NIC ~30s always-on | Pass |
| `persistHostNic` not in `pollRouterOnce` | Pass |
| Incident = `liveAdapterSnapshot` | Pass (incl. mac/description) |
| `wifi_events` prune with probes; retention 14 | Pass |
| Verdict sleep → isp → this_pc_wifi → unknown | Pass + competing matrix |
| Unknown evidence: ISP-up unproven | Pass |
| Nearby user-triggered, not `_tick` | Pass + coalesce |
| UniFi/Omada spark | Pass |
