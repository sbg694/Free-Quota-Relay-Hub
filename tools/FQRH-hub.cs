// FQRH 控制台启动器（编译成 FQRH-hub.exe）
// 作用：双击即用，不用记命令；内部还是调用 node 跑 src\server.mjs，逻辑只有一份。
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

internal static class FqrhHub
{
    private static string _root;

    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { /* 老终端忽略 */ }
        _root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        var node = FindNode();
        if (node == null)
        {
            Console.WriteLine("[FQRH] 没找到 node.exe。请安装 Node.js 22+（推荐 24）后重试。");
            return Pause(2);
        }

        // 支持命令行：FQRH-hub.exe serve   → 直接前台起网关（做快捷方式用）
        if (args.Length > 0 && (args[0] == "serve" || args[0] == "--serve")) return RunGateway(node);
        if (args.Length > 0 && (args[0] == "panel" || args[0] == "--panel")) { OpenPanel(); return 0; }

        while (true)
        {
            Console.WriteLine();
            Console.WriteLine("=== FQRH 免费额度中转枢纽 v3 ===");
            Console.WriteLine("    项目目录: " + _root);
            Console.WriteLine();
            Console.WriteLine("  1. 启动网关（前台运行，Ctrl+C 停止）");
            Console.WriteLine("  2. 打开管理面板（浏览器）");
            Console.WriteLine("  3. 查看接入信息（地址 / 客户端 key / 模型）");
            Console.WriteLine("  4. 运行离线自测（协议转换 + 网关集成）");
            Console.WriteLine("  5. 真实链路冒烟（会消耗上游免费额度）");
            Console.WriteLine("  6. 立即探活所有池");
            Console.WriteLine("  7. 今日账本日报");
            Console.WriteLine("  8. 打开项目 README / 文档目录");
            Console.WriteLine("  0. 退出");
            Console.Write("请选择: ");
            var choice = Console.ReadLine();
            if (choice == null) return 0;
            choice = choice.Trim();
            Console.WriteLine();

            if (choice == "0") return 0;
            if (choice == "1") RunGateway(node);
            else if (choice == "2") OpenPanel();
            else if (choice == "3") ShowInfo();
            else if (choice == "4") RunNode(node, new[] { @"src\test-convert.mjs" }, false);
            else if (choice == "5") RunNode(node, new[] { @"scripts\live-smoke.mjs" }, true);
            else if (choice == "6") ProbeAll();
            else if (choice == "7") RunNode(node, new[] { @"scripts\report.mjs" }, true);
            else if (choice == "8") OpenDocs();
            else Console.WriteLine("无效选项: " + choice);
        }
    }

    private static int Pause(int code)
    {
        Console.WriteLine();
        Console.WriteLine("按任意键退出…");
        try { Console.ReadKey(true); } catch { }
        return code;
    }

    private static string FindNode()
    {
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathVar.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* 路径非法，跳过 */ }
        }
        foreach (var guess in new[]
                 {
                     @"C:\Program Files\nodejs\node.exe",
                     @"C:\Program Files (x86)\nodejs\node.exe",
                 })
        {
            if (File.Exists(guess)) return guess;
        }
        return null;
    }

    private static int RunNode(string node, string[] nodeArgs, bool pauseAfter)
    {
        var quoted = new string[nodeArgs.Length];
        for (var i = 0; i < nodeArgs.Length; i++) quoted[i] = "\"" + nodeArgs[i].Replace("\"", "\\\"") + "\"";
        var psi = new ProcessStartInfo(node, string.Join(" ", quoted))
        {
            WorkingDirectory = _root,
            UseShellExecute = false,
        };
        try
        {
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                if (pauseAfter) Pause(0);
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FQRH] 启动 node 失败: " + ex.Message);
            return Pause(1);
        }
    }

    private static int RunGateway(string node)
    {
        var cfg = Path.Combine(_root, "config.json");
        var example = Path.Combine(_root, "config.example.json");
        if (!File.Exists(cfg) && File.Exists(example))
        {
            File.Copy(example, cfg);
            Console.WriteLine("[FQRH] 没有 config.json，已从 config.example.json 复制（记得填 key）。");
        }
        Console.WriteLine("[FQRH] 启动网关…（Ctrl+C 停止）");
        Console.WriteLine();
        var code = RunNode(node, new[] { @"src\server.mjs", "--config", "config.json" }, false);
        Console.WriteLine();
        Console.WriteLine("[FQRH] 网关已退出，代码 " + code);
        return Pause(code);
    }

    private static void OpenPanel()
    {
        var key = ReadClientKey();
        var url = "http://127.0.0.1:8790/__admin/dashboard";
        if (!string.IsNullOrEmpty(key)) url += "?key=" + Uri.EscapeDataString(key);
        Open(url);
        Console.WriteLine("[FQRH] 已打开面板: " + url.Replace("?key=" + key, "?key=***"));
        Console.WriteLine("        如果打不开，先选 1 启动网关。");
    }

    private static void OpenDocs()
    {
        var readme = Path.Combine(_root, "README.md");
        var docs = Path.Combine(_root, "docs");
        if (Directory.Exists(docs)) Open(docs);
        else if (File.Exists(readme)) Open(readme);
    }

    private static void Open(string target)
    {
        try { Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true }); }
        catch (Exception ex) { Console.WriteLine("[FQRH] 打开失败: " + ex.Message); }
    }

    private static void ShowInfo()
    {
        Console.WriteLine("  Base URL   : http://127.0.0.1:8790/v1");
        Console.WriteLine("  API Key    : " + (ReadClientKey() ?? "(见 config.json 的 clientKeys)"));
        Console.WriteLine("  模型        : dsv4.1（= deepseek-v4.1-flash-free）/ grok-4.5 … 见 GET /v1/models");
        Console.WriteLine("  管理面板    : http://127.0.0.1:8790/__admin/dashboard");
        Console.WriteLine("  主用池      : relay-free（priority 100）；备用 relay-backup（10）");
        Console.WriteLine("  配置文件    : " + Path.Combine(_root, "config.json"));
        Console.WriteLine("  修改 key/中转站：面板「常用操作」直接改，自动热重载。");
        Pause(0);
    }

    private static string ReadClientKey()
    {
        try
        {
            var path = Path.Combine(_root, "config.json");
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path);
            var m = Regex.Match(text, "\"clientKeys\"\\s*:\\s*\\[\\s*\\{[^}]*?\"key\"\\s*:\\s*\"([^\"]+)\"", RegexOptions.Singleline);
            return m.Success ? m.Groups[1].Value : null;
        }
        catch { return null; }
    }

    private static void ProbeAll()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8790/__admin/probe-all");
            req.Method = "POST";
            req.Timeout = 60000;
            var key = ReadClientKey();
            if (!string.IsNullOrEmpty(key)) req.Headers["Authorization"] = "Bearer " + key;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                Console.WriteLine(reader.ReadToEnd());
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FQRH] 探活失败: " + ex.Message);
            Console.WriteLine("        网关没在运行？先选 1 启动。");
        }
        Pause(0);
    }
}
