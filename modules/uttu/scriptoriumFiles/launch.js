'use strict';
// 从文坊起外部程序：用 VS Code 打开、在终端打开。
// 规矩：参数一律放数组，不经 shell，路径不拼进命令行字符串（文件名里可能有 & ^ 引号这些）。
// - VS Code：直接起 Code.exe（资源管理器右键“通过 Code 打开”也是这样）。PATH 里那个 `code` 在 Windows 上是 code.cmd，
//   起 .cmd 必须经 shell（Node 18.20 起不经 shell 直接起 .bat / .cmd 会报 EINVAL），所以从 code.cmd 所在的 bin 往上一层找 Code.exe；
//   没有再试 %LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe、%ProgramFiles%\Microsoft VS Code\Code.exe。别的系统找 PATH 里的 code。
// - 终端：Windows Terminal（wt.exe -d 文件夹）；没有就 PowerShell，在那个文件夹里开一个新窗口。
// 测试里用 setSpawn / setEnv 换掉真的起进程和环境变量。
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');

let spawnImpl = (command, args, options) => childProcess.spawn(command, args, options);
let envImpl = () => process.env;
let platformImpl = () => process.platform;
// WindowsApps 里的 wt.exe 是“应用执行别名”（重解析点），statSync 可能读不通，退回 lstatSync 看它在不在。
const exists = (file) => {
    try { return fs.statSync(file).isFile(); } catch (_) { /* 再看是不是别名 */ }
    try { return !fs.lstatSync(file).isDirectory(); } catch (_) { return false; }
};

function pathDirs() {
    const env = envImpl();
    const raw = env.PATH || env.Path || '';
    return raw.split(platformImpl() === 'win32' ? ';' : ':').map((dir) => dir.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
function onPath(names) {
    for (const dir of pathDirs()) {
        for (const name of names) {
            const file = path.join(dir, name);
            if (exists(file)) return file;
        }
    }
    return '';
}

function findVsCode() {
    const env = envImpl();
    if (platformImpl() !== 'win32') return onPath(['code']);
    const viaPath = onPath(['code.cmd', 'code']);
    if (viaPath) {
        const exe = path.resolve(path.dirname(viaPath), '..', 'Code.exe');
        if (exists(exe)) return exe;
    }
    const candidates = [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
        env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
    ].filter(Boolean);
    return candidates.find(exists) || '';
}

function findTerminal() {
    const env = envImpl();
    if (platformImpl() !== 'win32') return null;
    const wt = onPath(['wt.exe']) || (env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')].find(exists) : '');
    if (wt) return { kind: 'wt', command: wt };
    const system = env.SystemRoot || 'C:\\Windows';
    const powershell = onPath(['powershell.exe']) || path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { kind: 'powershell', command: powershell };
}

function start(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, ...options });
        } catch (error) {
            reject(error);
            return;
        }
        child.once?.('error', reject);
        // 起来了就不管它（不等它退出）。
        setTimeout(() => { child.unref?.(); resolve({ ok: true }); }, 150);
    });
}

// goto：target 末尾带“:行号”时跳到那一行（Code.exe -g）。
async function openInVsCode(target, { goto = false } = {}) {
    const code = findVsCode();
    if (!code) {
        throw new Error('没找到 VS Code。装好后（安装时勾上“添加到 PATH”）再试；或者装在默认位置 %LOCALAPPDATA%\\Programs\\Microsoft VS Code。');
    }
    await start(code, goto ? ['-g', target] : [target]);
    return { ok: true, command: code };
}

async function openTerminal(dir) {
    const terminal = findTerminal();
    if (!terminal) throw new Error('这台电脑上不知道用哪个终端（只认 Windows Terminal 和 PowerShell）。');
    if (terminal.kind === 'wt') await start(terminal.command, ['-d', dir]);
    else await start(terminal.command, ['-NoExit'], { cwd: dir });
    return { ok: true, command: terminal.command, kind: terminal.kind };
}

module.exports = {
    findVsCode, findTerminal, openInVsCode, openTerminal,
    setSpawn: (fn) => { spawnImpl = fn; },
    setEnv: (fn) => { envImpl = fn; },
    setPlatform: (fn) => { platformImpl = fn; },
};
