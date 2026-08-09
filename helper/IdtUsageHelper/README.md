# IdtUsageHelper

Elevated Windows helper for Internet Downtime Tracker **Usage** + Firewall **Control**.

- .NET 8 Windows (`net8.0-windows`), TraceEvent kernel `NetworkTCPIP`
- Named pipe auth via `--token` / `--pipe`
- Electron main process stays unelevated; UAC only when Usage is enabled

```powershell
dotnet publish -c Release -o publish
```

Output: `publish/IdtUsageHelper.exe` (packaged via electron-builder `extraResources` → `resources/helper/`).

**Packaging note:** Copy the full publish output (`*.exe`, `*.dll`, `*.json`, `amd64/**`). Do not put the helper inside `app.asar` — Windows cannot spawn it from asar. Missing `IdtUsageHelper.runtimeconfig.json` causes an immediate hostpolicy.dll crash.
