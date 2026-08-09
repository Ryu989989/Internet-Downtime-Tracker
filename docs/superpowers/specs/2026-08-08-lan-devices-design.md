# LAN Devices + peer gaps (A–H) — 2026-08-08

Passive Devices inventory through notify/metrics/subnet/router hooks. Electron stays **non-elevated by default**. Elevating features are Settings-gated. **Never** couple into `monitor._tick` (suppress-only for G scans / D port scan).

## Privilege / feasibility

| Surface | Privilege | Claim |
|---------|-----------|-------|
| **Devices** (A) | None | Neighbor cache + OUI/alias; not a complete map |
| **Topology** (B) | SNMP creds; elev if needed | SNMP walk + optional LLDP/CDP; seeds = gateway + known IPs |
| **Sniffer** (C/G) | Elevated helper | Metadata flows only by default; always-on opt-in |
| **Scan** (D/G) | User-triggered | Private/known IP only; CVE advisory/stale |
| **Notify / export / WOL** (E) | None | HTTPS webhooks + quiet hours; CSV/JSON; magic packet |
| **Metrics / API** (F) | Opt-in | Influx/ES push; Prometheus + REST on **127.0.0.1 only** |
| **Router webhook** (H) | Opt-in | Generic POST MAC/IP; no vendor plugin store |

**Non-goals:** Docker host-network appliance, `0.0.0.0` metrics/API, embedded Grafana, vendor plugin marketplace, “complete map” marketing.

## Tab IA

Rename chrome to **Network** (route `connections`). Segments: `Devices | Connections | Usage | Topology | Sniffer | Scan`.

## Schema / settings

```sql
lan_devices(
  mac TEXT PRIMARY KEY, ip TEXT, vendor TEXT, alias TEXT, notes TEXT,
  first_seen REAL, last_seen REAL, online INTEGER, source TEXT, gateway INTEGER
)
lan_scan_results(
  id INTEGER PK, target_ip TEXT, started_at REAL, finished_at REAL,
  ports_json TEXT, cve_json TEXT, status TEXT
)
```

Settings (defaults off unless noted): `lan_devices_enabled` (on), `lan_new_device_toast`, `snmp_enabled`, `snmp_community`, `snmp_targets`, `snmp_version`, `sniffer_enabled`, `sniffer_always_on`, `sniffer_payloads`, `notify_webhooks_json`, `notify_quiet_hours_json`, `influx_enabled` + url/token/org/bucket, `es_enabled` + url/api_key, `prom_metrics_enabled`, `http_api_enabled`, `http_api_token`, `lan_active_discovery`, `lan_discovery_interval_min` (≥5), `router_webhook_url`, `router_webhook_auto_new`.

## Isolation

1. No A–H work inside `monitor._tick`.
2. Tab-visible / Settings-driven polling only.
3. Port/subnet scans call `monitor.setProbeSuppress` while running.
4. Notify/router URLs: HTTPS preferred; block link-local/metadata/SSRF; never log secrets.
5. Prometheus/HTTP API bind `127.0.0.1` only — verified by test.
6. Preload allowlist + security tests for new IPC.

## Verify

`npm test` → mega-review PASS → `npm run build` → report exe path; **do not relaunch**.
