// modules/deskpet/fullscreenWatch.js
// 全屏让位：别的程序全屏（视频、游戏、放幻灯片）时桌宠先躲开，退出全屏再回来。
//
// Electron 拿不到前台窗口，Windows 上起一个常驻的 PowerShell，用 user32 每秒看一次前台窗口：
// 没有标题栏、盖住整块显示器的窗口，或者系统报告的独占全屏 / 演示模式，就算全屏。
// 状态变了才往 stdout 写一行：`fs <x> <y> <宽> <高>`（那块显示器的物理像素）或 `none`。
// 前台是 VCPChat 自己（桌宠、主窗口）时不算；VCPChat 退出后脚本自己结束，不会留下孤儿进程。
// 其他平台不做（macOS 全屏程序在自己的桌面空间里，桌宠本来就不在那儿；Linux 没有统一的办法）。

'use strict';

const POLL_MS = 1000;
// 进程意外退出后过一会儿再起，最多重试几次，免得每秒拉起一个失败的 PowerShell。
const RESTART_MS = 30000;
const MAX_RESTARTS = 3;

const PROBE_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VcpFullscreen {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);

    // 按物理像素报坐标，主进程再换成 DIP
    public static void Init() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    public static string Probe(uint ownPid) {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero || !IsWindowVisible(h)) return "none";
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (pid == ownPid) return "none";
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        string c = cls.ToString();
        // 桌面和任务栏本身就是整屏大小
        if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return "none";
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return "none";
        RECT r;
        if (!GetWindowRect(h, out r)) return "none";
        RECT s = mi.rcMonitor;
        // 最大化的普通窗口（任务栏自动隐藏时也盖满整屏）带标题栏，不算
        bool captioned = (GetWindowLong(h, -16) & 0x00C00000) == 0x00C00000;
        bool covers = r.Left <= s.Left && r.Top <= s.Top && r.Right >= s.Right && r.Bottom >= s.Bottom;
        int state = 0;
        try { SHQueryUserNotificationState(out state); } catch (Exception) { }
        // 3：独占全屏（D3D），4：演示模式
        if ((covers && !captioned) || state == 3 || state == 4) {
            return "fs " + s.Left + " " + s.Top + " " + (s.Right - s.Left) + " " + (s.Bottom - s.Top);
        }
        return "none";
    }
}
`;

function buildScript(ownPid, pollMs = POLL_MS) {
    const pid = typeof ownPid === 'number' ? ownPid : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('bad pid');
    return [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -TypeDefinition @'",
        PROBE_SOURCE.trim(),
        "'@",
        '[VcpFullscreen]::Init()',
        "$last = ''",
        'while ($true) {',
        `    try { $null = [System.Diagnostics.Process]::GetProcessById(${pid}) } catch { break }`,
        `    $now = [VcpFullscreen]::Probe(${pid})`,
        '    if ($now -ne $last) { [Console]::Out.WriteLine($now); [Console]::Out.Flush(); $last = $now }',
        `    Start-Sleep -Milliseconds ${Math.max(200, Math.round(pollMs))}`,
        '}',
    ].join('\n');
}

/** PowerShell 的 -EncodedCommand：UTF-16LE 再 base64，免得引号和换行被命令行拆坏。 */
function encodeCommand(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/** 一行输出 → { fullscreen, rect }；看不懂的行返回 null。rect 是物理像素。 */
function parseLine(line) {
    const text = String(line || '').trim();
    if (text === 'none') return { fullscreen: false, rect: null };
    const match = /^fs (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(text);
    if (!match) return null;
    const [x, y, width, height] = match.slice(1).map(Number);
    if (!width || !height) return null;
    return { fullscreen: true, rect: { x, y, width, height } };
}

/**
 * start() 起监视，stop() 停；onChange({ fullscreen, rect }) 只在状态变了时调。
 * spawn 和 platform 可以换掉，测试里不起真进程。
 */
function createFullscreenWatch({
    spawn = require('child_process').spawn,
    platform = process.platform,
    ownPid = process.pid,
    onChange = () => {},
    pollMs = POLL_MS,
    restartMs = RESTART_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    let child = null;
    let wanted = false;
    let restarts = 0;
    let restartTimer = null;
    let current = { fullscreen: false, rect: null };
    let heard = false;   // 脚本报过至少一行（编译、运行都没问题）

    function report(next) {
        if (next.fullscreen === current.fullscreen && JSON.stringify(next.rect) === JSON.stringify(current.rect)) return;
        current = next;
        try { onChange(next); } catch (error) { console.warn('[DeskPet] fullscreen listener:', error.message); }
    }

    function launch() {
        let proc;
        try {
            proc = spawn('powershell.exe', [
                '-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-EncodedCommand', encodeCommand(buildScript(ownPid, pollMs)),
            ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            console.warn('[DeskPet] fullscreen watch unavailable:', error.message);
            return;
        }
        child = proc;
        // 不拖住退出：应用要关时不用等它（脚本发现 VCPChat 没了也会自己结束）
        proc.unref?.();
        proc.stdout.unref?.();
        proc.stderr?.unref?.();
        let buffer = '';
        proc.stdout.setEncoding?.('utf8');
        proc.stdout.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) {
                const state = parseLine(line);
                if (state) {
                    heard = true;
                    restarts = 0;
                    report(state);
                }
            }
        });
        let errors = '';
        proc.stderr?.on('data', (chunk) => { if (errors.length < 2000) errors += chunk; });
        const ended = () => {
            if (child !== proc) return;
            child = null;
            // 进程没了就当没有全屏，桌宠不能一直躲着
            report({ fullscreen: false, rect: null });
            if (!wanted) return;
            if (errors.trim()) console.warn('[DeskPet] fullscreen watch stopped:', errors.trim().slice(0, 300));
            if (restarts >= MAX_RESTARTS) return;
            restarts += 1;
            restartTimer = setTimer(() => {
                restartTimer = null;
                if (wanted && !child) launch();
            }, restartMs);
            restartTimer?.unref?.();
        };
        proc.on('exit', ended);
        proc.on('error', (error) => {
            errors += error.message;
            ended();
        });
    }

    return {
        start() {
            if (platform !== 'win32' || wanted) return;
            wanted = true;
            restarts = 0;
            launch();
        },
        stop() {
            wanted = false;
            if (restartTimer) clearTimer(restartTimer);
            restartTimer = null;
            const proc = child;
            child = null;
            if (proc) {
                try { proc.kill(); } catch { /* 已经退出 */ }
            }
            report({ fullscreen: false, rect: null });
        },
        get running() { return Boolean(child); },
        get heard() { return heard; },
        get state() { return current; },
    };
}

module.exports = { POLL_MS, buildScript, encodeCommand, parseLine, createFullscreenWatch };
