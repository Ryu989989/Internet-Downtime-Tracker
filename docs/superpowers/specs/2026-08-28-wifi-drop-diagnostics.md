# Wi-Fi drop diagnostics (peer gap pass) — 2026-08-28

Locked from plan `wifi_drop_diagnostics_cc38dd3c`. Chronicle-first. Electron **unelevated**. No `wifi` outage type. No fake dBm/SNR. Heavy work **not** on `monitor._tick`.

**Status:** implementing. Do not stamp CLEAR_OK until grep gates + `npm test` pass.

## Live contracts (do not invert)

| Topic | Live today | This pass |
|-------|------------|-----------|
| Outage domains | `lan\|wan\|dns\|http` only | **Unchanged.** No `wifi` type. |
| WAN while LAN down | `probe()` skips WAN/DNS/HTTP | **Unchanged.** Verdict may be `unknown`. |
| Windows RSSI | `parseNetshWlanInterfaces` → `rssi: null` | **Still null** unless OS text literally has dBm (`RSSI` / `Signal … dBm`). **Never** `% → dBm`. |
| Host NIC samples | Only inside `pollRouterOnce` (`router_poll_enabled`) | **Always** ~30s lan-bridge timer, `source: host_nic`. |
| Incident snapshot adapter | `{name,type,signal}` only | **Use** `liveAdapterSnapshot` (ssid/bssid/band/channel/rssi/signal/tx_mbps/rx_mbps/mac/description). |
| System logs | 8001/8003 gaps; message clip 200 | **Add** IDs + EventData + chronicle kinds. Gaps remain; sleep labeled, not Wi-Fi fault. |
| `probe_retention_days` | 14 | **Unchanged.** Prune `wifi_events` with probes. |
| Privilege | asInvoker | **Unchanged.** Nearby BSS / Event Log may be empty; honest warning. |

## Yes / Skip

**Yes Wave 1:** host_nic timer; richer netsh fields; BSSID roam events; WLAN chronicle; verdict; full incident radio; Overview BSSID/rate/state + verdict chip; History badge; UniFi/Omada spark; `wifi-alerts.test.js` in `npm test`.

**Yes Wave 2:** user-triggered Nearby BSS (`netsh wlan show networks mode=bssid` / `iw scan`). Not on `_tick`. Not a heatmap.

**Skip:** heatmaps, monitor mode, Npcap, `%→dBm`, fake SNR, `wlanreport` HTML, Native WLAN helper, `wifi` outage type, WAN-while-LAN-down, roaming-aggressiveness writes, widget SSID, CoreWLAN/`wdutil`, retention bump.

## Module APIs

### `electron/netcheck.js`

Export `parseNetshWlanInterfaces`, `parseNetshWlanNetworks`, `parseIwScan` (Wave 2).

`parseNetshWlanInterfaces(text)` extra fields: `state` (`connected`/`disconnected`/null), `radio_type`, `auth`, `cipher`. Prefer a `State: connected` block. `rssi` only from an explicit dBm token; Signal `85%` → `signal: 85`, `rssi: null`.

`emptyAdapter` / `fillWifiGaps` include those keys.

`getActiveAdapter()` copies new fields onto the adapter object.

### `electron/wifi-chronicle.js` (new)

Pure functions. No I/O, no `monitor`.

```js
classifyWlanEvent({ id, eventData, message, time, source })
// → { kind: "roam"|"disconnect"|"connect"|"fail"|"sleep"|null, reason_code, reason_text, ssid, bssid, event_id, at, source }

detectHostNicRoam(prevSample, nextSample)
// → { kind:"roam", source:"host_nic", at, ssid, bssid_from, bssid_to } | null
// roam iff both BSSIDs present, normalized unequal, and SSIDs equal or either SSID missing.

eventsToChronicle(events)  // classify each; coalesce 8003+8001 different BSSID within 15s → one roam

correlateVerdict({
  lanOutage,          // {type,started_at,ended_at}|null
  wanOutage,          // overlapping wan row or null
  wlanEvents,         // chronicle rows overlapping [start,end]
  routerWanOk,        // true|false|null
  peersOnlineDuring,  // true|false|null
})
// priority: sleep (any sleep overlap) → isp (wanOutage with lan up, or routerWanOk===false)
// → this_pc_wifi (lan outage + disconnect|roam AND (routerWanOk===true OR peersOnlineDuring===true))
// → unknown
// → { code, label, evidence: string[] }
```

Labels: `this_pc_wifi` → `This PC Wi-Fi`; `isp` → `ISP / WAN`; `sleep` → `Sleep / resume`; `unknown` → `Unknown`.

Unknown evidence must mention ISP-up is unproven without router poll or other devices staying online.

### `electron/system-logs.js`

`QUERY_SPECS` add WLAN ids: **8000, 8002, 11000, 11001, 11002, 11004, 11005, 11006, 12013**. Add System **Kernel-Power** ids **42, 107** (label `Kernel-Power`). Keep existing NetworkProfile / 8001 / 8003 / NIC ids.

Scan script: include `EventData` object from event XML `EventData/Data[@Name]`; message clip **800** (not 200).

`classifyEvent`: 8003/10001/11004 → disconnect; 8001/8000/8002/10000/11000/11001/11005 → connect; 11002/11006 → fail (not a gap closer); 42 → sleep; 107 → resume (connect-like for gap close). Fail events do **not** open gaps.

`normalizeRawEvents` keeps `eventData`. `scanWindowsLogs` result adds `events` (normalized, capped) for ingest. Existing `gaps` stay.

Export `QUERY_SPECS` (or ids) for tests.

### `electron/db.js`

```sql
CREATE TABLE IF NOT EXISTS wifi_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at REAL NOT NULL,
  kind TEXT NOT NULL,
  ssid TEXT,
  bssid_from TEXT,
  bssid_to TEXT,
  reason_code TEXT,
  reason_text TEXT,
  event_id INTEGER,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_wifi_events_at ON wifi_events(at);
```

`insertWifiEvent(row)` — skip if `kind` empty. Dedup: same `at` (1s), `kind`, `source`, `event_id` already present → no-op.

`listWifiEvents({ fromTs, toTs, limit=500 })`

`pruneProbes` also `DELETE FROM wifi_events WHERE at < cutoff`. Tests: `usage-db.test.js` grep + count.

### `electron/lan-bridge.js`

- `HOST_NIC_INTERVAL_MS = 30_000`. `startHostNicPoll` / `stopHostNicPoll`. Always-on from `applyIntegrationSettings` (even if router poll off). `shutdown` + `resetRouterPollForTest` stop it. `unref` the timer.
- Timer tick: `persistHostNic` then `checkWifiAlerts`. `pollRouterOnce` **stops** calling `persistHostNic` (avoid double samples). Router-client alerts still run in `pollRouterOnce`.
- After `insertWifiSample` host_nic, `detectHostNicRoam(prev, next)` → `insertWifiEvent`. Keep last host_nic sample in memory.
- `ingestWlanChronicle({ from, to })` — `scanWindowsLogs` (not on monitor tick); map via `eventsToChronicle` / `classifyWlanEvent`; insert. Debounce 10s. Called from `onOutageEvent` when `kind===outage_open` and `outage.type==="lan"`, window `[started_at-60, now]`.
- `wifiVerdictForOutage(outage)` + `liveWifiVerdict()` using latest router health `wan_ok`, peers (`lan_devices` online count excluding this host mac > 0), overlapping events. Attach on status via `liveWifiVerdict()`.

### `electron/monitor.js` (parent only)

- `buildIncidentSnapshot` adapter = `liveAdapterSnapshot(state.adapter)` (may be null).
- `_maybeRefreshAdapter`: if current `adapter.type==="wifi"`, refresh every `QUALITY_EVERY_N` (6), else keep `ADAPTER_EVERY_N` (30). **No** Event Log / nearby scan / lan-bridge require.

### Verdict payload

`status.wifi_verdict = { code, label, evidence }` from `liveWifiVerdict()`. History: store `wifi_verdict` on `snapshot_json` at open (lan-bridge after ingest) when possible; UI also shows badge from `o.wifi_verdict` or snapshot.

### Nearby BSS (Wave 2) — `electron/wifi-nearby.js`

`parseNetshWlanNetworks(text)` / `parseIwScan(text)` → `{ ssid, bssid, channel, signal, security, band }[]`. IPC `api:lan:wifi:nearby` on-demand. Disclaimer: point-in-time, may miss hidden SSIDs, not a site survey. Scan tab sibling. `monitor.js` must not mention `wifi-nearby` / `iw scan` / `show networks`.

## File ownership

| Wave | May write | Must not |
|------|-----------|----------|
| 1a netcheck | `electron/netcheck.js`, `electron/test/cross-platform.test.js` | `app.js`, `monitor.js`, `db.js`, `lan-bridge.js` |
| 1b chronicle | `electron/wifi-chronicle.js` (new), `electron/system-logs.js`, `electron/test/system-logs.test.js`, `electron/test/wifi-chronicle.test.js` (new) | `app.js`, `monitor.js`, `db.js`, `lan-bridge.js`, `netcheck.js` |
| 1c host samples | `electron/lan-bridge.js`, `electron/db.js`, `electron/test/router-poll.test.js`, `electron/test/usage-db.test.js` | `app.js`, `monitor.js`, `netcheck.js`, `system-logs.js`, `wifi-chronicle.js` (require only) |
| 1d parent | `monitor.js`, `main.js`, `preload.js`, `web/app.js`, `web/index.html`, `web/styles.css`, `README.md`, `package.json` test list, `electron/test/monitor.test.js`, `electron/test/ui.test.js`, `electron/test/lan-security.test.js`, `electron/test/security.test.js` | parsers owned by 1a/1b |
| 2 nearby | `electron/wifi-nearby.js`, tests; parent IPC + Scan UI | `_tick`, `probe()` |

## Grep gates

`electron/monitor.js` must **not** match: `Get-WinEvent`, `system-logs`, `wifi-chronicle`, `wifi-nearby`, `iw scan`, `show networks`, `lan-bridge`, `wlanreport`.

No `%→dBm` / `rssiToPct` in Overview paint. No `type === "wifi"` outage insert.

## Copy

- Tips: Windows netsh Signal is percent, not dBm. We do not convert.
- Verdict unknown: ISP-up is unproven without router poll or other devices staying online.
- Nearby BSS: Snapshot when you clicked — not a site survey.
- System logs: Sleep overlaps are labeled sleep, not Wi-Fi faults.
