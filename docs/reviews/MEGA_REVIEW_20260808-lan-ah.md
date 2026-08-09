# Mega Review — LAN Devices A–H (2026-08-08)

**Scope:** Phases A–H (Devices, SNMP, Sniffer, Port/CVE, Notify/Export/WOL, Metrics/API, Subnet/always-on sniff, Router webhooks) + README matrix.  
**CI:** `npm test` — **99/99 pass** (re-run after High fixes).  
**Verdict: Ship**

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Correctness | 8 | Sniffer is connection-delta metadata (not Npcap); honestly labeled |
| Security | 8 | Highs fixed (`[::1]` SSRF, API token rotation); secrets still in settings IPC (Medium, mitigated by CSP/isolation) |
| Privilege honesty | 9 | Settings gates; elev for Usage; Devices/WOL unelevated |
| Isolation | 10 | No `monitor._tick` coupling; suppress-only for scan/discovery |
| Tests | 9 | lan-devices + lan-security + UI contracts |
| Docs | 9 | Spec + README privilege matrix |

## Top fix first (resolved before Ship)

1. **[HIGH→fixed]** Webhook SSRF: block `[::1]`, `0.0.0.0`, `169.254.0.0/16` in `notify-webhooks.js`.
2. **[HIGH→fixed]** Restart localhost HTTP API when token/enable changes (`lan-bridge.applyIntegrationSettings`).
3. **[MED→fixed]** Enforce known-device for port scan; drop IPC `body.url` router override; drop sniffer `force` Settings bypass.

## Post-review follow-up (code-reviewer Important)

Fixed after Ship draft: probe-suppress **refcount**; webhook persist validation; HTTP API bind+token test; sniffer honesty (connection-flow, not elevated); `*.local`/`fe80` webhook block; drop SNMP `127.0.0.1` seed; `listDevices` Settings gate; snmp community password field.

## Remaining (non-blocking)

| Sev | Item |
|-----|------|
| M | Prometheus `/metrics` unauthenticated on localhost (intentional; document) |
| M | Settings IPC still returns tokens to renderer (write-only redact follow-up) |
| L | Query-string API token accepted; timing-safe compare optional |

## Critical → Low (open)

**Critical:** none  
**High:** none (post-fix)  
**Medium:** Prometheus local scrape; settings secret surface  
**Low:** Bearer-preferred auth polish

## Adversarial cross-check (Grok synthesis + Composer security)

- **_tick coupling:** verified absent (`lan-security.test.js` + main grep).
- **Bind:** `metrics-api.BIND_HOST === "127.0.0.1"`; listen tests green.
- **Scan allowlist:** private/local + known Devices inventory.
- **CVE:** advisory/stale flags in JSON + UI copy.
- **Non-goals honored:** no Docker/Grafana embed; no `0.0.0.0` metrics.

## Fable-judge claims

| Claim | Status |
|-------|--------|
| `npm test` exit 0 | **verified** (99 pass) |
| Debounce/WAN-suppress unchanged | **verified** (monitor tests still green) |
| Localhost-only Prometheus | **verified** (unit + listen test) |
| No `_tick` LAN coupling | **verified** |
| Privilege Settings gates | **verified** (code + README) |
| Packaged rebuild | **pending** → next step `npm run build` |
| App not relaunched | **verified** (constraint) |

## Ship

**Ship** — open Criticals: 0; Highs fixed; Mediums acceptable for local tray app with honest docs.
