'use strict';

const { spawn } = require('child_process');

function managedSpawnOptions(platform = process.platform) {
    return {
        detached: platform !== 'win32',
        windowsHide: platform === 'win32',
    };
}

function terminationPlan(pid, { platform = process.platform, signal = 'SIGTERM' } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return { kind: 'child', signal };
    if (platform === 'win32') {
        return {
            kind: 'command',
            command: 'taskkill.exe',
            args: ['/PID', String(pid), '/T', '/F'],
            options: { windowsHide: true, stdio: 'ignore' },
        };
    }
    return { kind: 'process-group', pid: -pid, signal };
}

function terminateManagedProcess(child, {
    platform = process.platform,
    signal = 'SIGTERM',
    spawnProcess = spawn,
    killProcess = process.kill.bind(process),
} = {}) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    const plan = terminationPlan(child.pid, { platform, signal });
    try {
        if (plan.kind === 'command') spawnProcess(plan.command, plan.args, plan.options);
        else if (plan.kind === 'process-group') {
            try { killProcess(plan.pid, plan.signal); } catch { child.kill(plan.signal); }
        } else child.kill(plan.signal);
        return true;
    } catch {
        return false;
    }
}

module.exports = { managedSpawnOptions, terminationPlan, terminateManagedProcess };
