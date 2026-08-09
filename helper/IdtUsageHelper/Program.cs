using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;

namespace IdtUsageHelper;

internal static class Program
{
    static readonly ConcurrentDictionary<int, AppCounters> ByPid = new();
    static readonly ConcurrentDictionary<string, AppCounters> ByKey = new();
    static volatile bool Suppress;
    static volatile bool Running = true;
    static string ExpectedToken = "";
    static string PipeName = "IdtUsageHelper";
    static TraceEventSession? Session;

    static int Main(string[] args)
    {
        string? tokenFile = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--token-file" && i + 1 < args.Length) tokenFile = args[++i];
            else if (args[i] == "--token" && i + 1 < args.Length) ExpectedToken = args[++i];
            else if (args[i] == "--pipe" && i + 1 < args.Length) PipeName = args[++i];
        }
        if (!string.IsNullOrWhiteSpace(tokenFile))
        {
            try
            {
                ExpectedToken = File.ReadAllText(tokenFile).Trim();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("token-file read failed: " + ex.Message);
                return 2;
            }
        }
        if (string.IsNullOrWhiteSpace(ExpectedToken))
        {
            Console.Error.WriteLine("missing --token-file or --token");
            return 2;
        }

        var elevated = IsElevated();
        try
        {
            if (elevated) StartEtw();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ETW start failed: " + ex.Message);
        }

        try
        {
            ServePipe(elevated);
        }
        finally
        {
            Running = false;
            try { Session?.Dispose(); } catch { /* ignore */ }
        }
        return 0;
    }

    static bool IsElevated()
    {
        using var id = WindowsIdentity.GetCurrent();
        var principal = new WindowsPrincipal(id);
        return principal.IsInRole(WindowsBuiltInRole.Administrator);
    }

    static void StartEtw()
    {
        var sessionName = "IdtUsage-" + Process.GetCurrentProcess().Id;
        Session = new TraceEventSession(sessionName);
        Session.EnableKernelProvider(KernelTraceEventParser.Keywords.NetworkTCPIP);
        Session.Source.Kernel.TcpIpRecv += data => OnNet(data.ProcessID, data.size, inbound: true);
        Session.Source.Kernel.TcpIpSend += data => OnNet(data.ProcessID, data.size, inbound: false);
        Session.Source.Kernel.TcpIpRecvIPV6 += data => OnNet(data.ProcessID, data.size, inbound: true);
        Session.Source.Kernel.TcpIpSendIPV6 += data => OnNet(data.ProcessID, data.size, inbound: false);
        Session.Source.Kernel.UdpIpRecv += data => OnNet(data.ProcessID, data.size, inbound: true);
        Session.Source.Kernel.UdpIpSend += data => OnNet(data.ProcessID, data.size, inbound: false);
        Session.Source.Kernel.UdpIpRecvIPV6 += data => OnNet(data.ProcessID, data.size, inbound: true);
        Session.Source.Kernel.UdpIpSendIPV6 += data => OnNet(data.ProcessID, data.size, inbound: false);
        _ = Task.Run(() =>
        {
            try { Session.Source.Process(); }
            catch { /* session disposed */ }
        });
    }

    static void OnNet(int pid, int size, bool inbound)
    {
        if (Suppress || size <= 0 || pid <= 0) return;
        var c = ByPid.GetOrAdd(pid, _ => new AppCounters(pid));
        if (inbound) Interlocked.Add(ref c.BytesIn, size);
        else Interlocked.Add(ref c.BytesOut, size);
        c.Touch();
    }

    static void ServePipe(bool elevated)
    {
        // Restrict to the launching user SID (same identity when elevated via UAC).
        // Avoid BuiltinUsers — any local user could otherwise connect and present the token.
        using var identity = WindowsIdentity.GetCurrent();
        var userSid = identity.User
            ?? throw new InvalidOperationException("current user SID unavailable");
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            userSid,
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        while (Running)
        {
            using var server = NamedPipeServerStreamAcl.Create(
                PipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                0,
                0,
                security);

            server.WaitForConnection();
            using var reader = new StreamReader(server, Encoding.UTF8, false, 4096, leaveOpen: true);
            using var writer = new StreamWriter(server, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };

            string? line;
            while (Running && (line = reader.ReadLine()) != null)
            {
                var resp = Handle(line, elevated);
                writer.WriteLine(resp);
                if (resp.Contains("\"cmd\":\"quit\"", StringComparison.Ordinal))
                {
                    Running = false;
                    break;
                }
            }
        }
    }

    static string Handle(string line, bool elevated)
    {
        Dictionary<string, JsonElement>? msg;
        try
        {
            msg = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(line);
        }
        catch
        {
            return JsonSerializer.Serialize(new { ok = false, error = "bad json" });
        }
        if (msg is null) return JsonSerializer.Serialize(new { ok = false, error = "empty" });

        var token = msg.TryGetValue("token", out var tokEl) ? tokEl.GetString() : null;
        if (!string.Equals(token, ExpectedToken, StringComparison.Ordinal))
            return JsonSerializer.Serialize(new { ok = false, id = IdOf(msg), error = "unauthorized" });

        var cmd = msg.TryGetValue("cmd", out var cmdEl) ? cmdEl.GetString() : "";
        var id = IdOf(msg);
        switch (cmd)
        {
            case "hello":
                return JsonSerializer.Serialize(new { ok = true, id, cmd, elevated, version = "1.0.0" });
            case "ping":
                return JsonSerializer.Serialize(new { ok = true, id, cmd = "pong" });
            case "set_suppress":
                Suppress = msg.TryGetValue("on", out var onEl) && onEl.ValueKind == JsonValueKind.True;
                return JsonSerializer.Serialize(new { ok = true, id, cmd, on = Suppress });
            case "get_live":
                return JsonSerializer.Serialize(new
                {
                    ok = true,
                    id,
                    cmd = "live",
                    suppressed = Suppress,
                    elevated,
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    apps = SnapshotApps()
                });
            case "block":
                return Firewall(msg, id, block: true);
            case "unblock":
                return Firewall(msg, id, block: false);
            case "quit":
                return JsonSerializer.Serialize(new { ok = true, id, cmd = "quit" });
            default:
                return JsonSerializer.Serialize(new { ok = false, id, error = "unknown cmd" });
        }
    }

    static object? IdOf(Dictionary<string, JsonElement> msg)
        => msg.TryGetValue("id", out var id) ? id.ValueKind == JsonValueKind.Number ? id.GetInt32() : id.ToString() : null;

    static List<object> SnapshotApps()
    {
        var now = DateTime.UtcNow;
        var list = new List<(double score, object row)>();
        foreach (var kv in ByPid.ToArray())
        {
            var c = kv.Value;
            var dt = Math.Max(0.001, (now - c.LastRateAt).TotalSeconds);
            var totalIn = Interlocked.Read(ref c.BytesIn);
            var totalOut = Interlocked.Read(ref c.BytesOut);
            var din = totalIn - c.LastIn;
            var dout = totalOut - c.LastOut;
            c.LastIn = totalIn;
            c.LastOut = totalOut;
            c.LastRateAt = now;
            ResolveProcess(c);
            var rateIn = din * 8.0 / (dt * 1e6);
            var rateOut = dout * 8.0 / (dt * 1e6);
            if (totalIn == 0 && totalOut == 0) continue;
            list.Add((rateIn + rateOut, new
            {
                pid = c.Pid,
                name = c.Name,
                exe = c.Exe,
                app_key = c.AppKey,
                bytes_in = totalIn,
                bytes_out = totalOut,
                rate_in_mbps = rateIn,
                rate_out_mbps = rateOut,
            }));
        }
        return list
            .OrderByDescending(x => x.score)
            .Take(100)
            .Select(x => x.row)
            .ToList();
    }

    static void ResolveProcess(AppCounters c)
    {
        if (!string.IsNullOrEmpty(c.Name) && (DateTime.UtcNow - c.ResolvedAt).TotalSeconds < 30)
            return;
        try
        {
            using var p = Process.GetProcessById(c.Pid);
            c.Name = p.ProcessName;
            try { c.Exe = p.MainModule?.FileName ?? ""; } catch { c.Exe = ""; }
            c.AppKey = !string.IsNullOrEmpty(c.Exe)
                ? c.Exe.ToLowerInvariant()
                : (c.Name ?? ("pid:" + c.Pid)).ToLowerInvariant();
            c.ResolvedAt = DateTime.UtcNow;
        }
        catch
        {
            c.Name ??= "pid:" + c.Pid;
            c.AppKey ??= ("pid:" + c.Pid).ToLowerInvariant();
        }
    }

    static string Firewall(Dictionary<string, JsonElement> msg, object? id, bool block)
    {
        if (!IsElevated())
            return JsonSerializer.Serialize(new { ok = false, id, error = "not elevated" });
        var exe = msg.TryGetValue("exe", out var exeEl) ? exeEl.GetString() : null;
        if (string.IsNullOrWhiteSpace(exe) || exe.Length > 512 || exe.IndexOfAny(['"', '\n', '\r', '\0']) >= 0)
            return JsonSerializer.Serialize(new { ok = false, id, error = "bad exe" });
        if (!(exe.Length >= 3 && char.IsLetter(exe[0]) && exe[1] == ':' && exe[2] == '\\') && !exe.StartsWith("\\\\", StringComparison.Ordinal))
            return JsonSerializer.Serialize(new { ok = false, id, error = "bad exe path" });

        var rule = "IDT Block " + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(exe.ToLowerInvariant())))[..16];
        try
        {
            if (block)
            {
                RunPs($"$n='{EscapePs(rule)}'; $p='{EscapePs(exe)}'; New-NetFirewallRule -DisplayName $n -Direction Outbound -Program $p -Action Block -ErrorAction Stop | Out-Null; New-NetFirewallRule -DisplayName ($n+' in') -Direction Inbound -Program $p -Action Block -ErrorAction SilentlyContinue | Out-Null");
            }
            else
            {
                RunPs($"Get-NetFirewallRule -DisplayName 'IDT Block *' -ErrorAction SilentlyContinue | Where-Object {{ $_.DisplayName -like '{EscapePs(rule)}*' }} | Remove-NetFirewallRule -ErrorAction SilentlyContinue");
                // Also remove by exact names we create
                RunPs($"Remove-NetFirewallRule -DisplayName '{EscapePs(rule)}' -ErrorAction SilentlyContinue; Remove-NetFirewallRule -DisplayName '{EscapePs(rule + " in")}' -ErrorAction SilentlyContinue");
            }
            return JsonSerializer.Serialize(new { ok = true, id, cmd = block ? "block" : "unblock", rule, exe });
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new { ok = false, id, error = ex.Message });
        }
    }

    static string EscapePs(string s) => s.Replace("'", "''");

    static void RunPs(string script)
    {
        var psi = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " + script,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("powershell failed");
        p.WaitForExit(15000);
        if (p.ExitCode != 0)
        {
            var err = p.StandardError.ReadToEnd();
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(err) ? $"powershell exit {p.ExitCode}" : err);
        }
    }

    sealed class AppCounters(int pid)
    {
        public int Pid = pid;
        public long BytesIn;
        public long BytesOut;
        public long LastIn;
        public long LastOut;
        public DateTime LastRateAt = DateTime.UtcNow;
        public DateTime ResolvedAt = DateTime.MinValue;
        public string? Name;
        public string? Exe;
        public string? AppKey;
        public void Touch() { }
    }
}
