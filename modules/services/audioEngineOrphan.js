'use strict';

// VCPChat 被强行结束（任务管理器、崩溃、断电重启前的卡死）时，Windows 不会顺带结束子进程：
// 音频引擎 audio_server 留在后台，占着两三百 MB 内存、一个端口，有时还在出声。下次启动换了端口，
// 旧的那个就一直没人管，越攒越多。
//
// 所以启动引擎时把它的 PID 和启动它的 VCPChat 主进程 PID 记到应用数据目录里，正常退出时删掉。
// 下次启动先看记录：主进程已经不在、引擎 PID 还活着、而且那个进程确实是同名的引擎程序，才结束它。
// 主进程还活着（同一数据目录开了两个实例）、PID 被别的程序重用了，都不动。

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
let tmpSeq = 0;

function readRecord(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && Number.isInteger(data.pid) && data.pid > 0) return data;
    } catch (_) { /* 没有记录或记录坏了 */ }
    return null;
}

function writeRecord(file, record) {
    let tmp = null;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record));
        fs.renameSync(tmp, file);
        tmp = null;
    } catch (error) {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
        console.warn(`[AudioEngine] Could not record engine pid: ${error.message}`);
    }
}

function clearRecord(file, pid) {
    const current = readRecord(file);
    if (current && pid !== undefined && current.pid !== pid) return; // 已经是别的引擎的记录了
    try { fs.unlinkSync(file); } catch (_) { /* 已经没了 */ }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// 取进程的可执行文件名（小写），拿不到就返回 null。
function imageName(pid, { platform = process.platform, run = execFile } = {}) {
    return new Promise((resolve) => {
        if (platform === 'win32') {
            run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 4000, windowsHide: true }, (error, stdout) => {
                if (error) return resolve(null);
                const match = /^"([^"]+)","(\d+)"/m.exec(String(stdout || ''));
                resolve(match && Number(match[2]) === pid ? match[1].toLowerCase() : null);
            });
            return;
        }
        if (platform === 'darwin') {
            run('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 4000 }, (error, stdout) => {
                if (error) return resolve(null);
                const comm = String(stdout || '').trim();
                resolve(comm ? comm.split('/').pop().toLowerCase() : null);
            });
            return;
        }
        fs.readFile(`/proc/${pid}/comm`, 'utf8', (error, text) => resolve(error ? null : String(text).trim().toLowerCase()));
    });
}

async function reapOrphan(file, {
    binaryPath,
    alive = isAlive,
    image = imageName,
    kill = (pid) => process.kill(pid),
    log = console
} = {}) {
    const record = readRecord(file);
    if (!record) return { reaped: false, reason: 'no-record' };
    if (Number.isInteger(record.ownerPid) && record.ownerPid !== process.pid && alive(record.ownerPid)) {
        return { reaped: false, reason: 'owner-alive' };
    }
    if (!alive(record.pid)) {
        clearRecord(file);
        return { reaped: false, reason: 'gone' };
    }
    const expected = String(binaryPath || record.binary || '').split(/[\\/]/).pop().toLowerCase();
    const actual = await image(record.pid);
    // Linux 的 comm 最多 15 个字符
    const same = Boolean(expected && actual) && (actual === expected || (actual.length >= 15 && expected.startsWith(actual)));
    if (!same) {
        clearRecord(file);
        return { reaped: false, reason: 'pid-reused' };
    }
    try {
        kill(record.pid);
        log.warn?.(`[AudioEngine] Ended an audio engine (pid ${record.pid}) left behind by a previous VCPChat run.`);
    } catch (error) {
        log.warn?.(`[AudioEngine] Could not end leftover audio engine pid ${record.pid}: ${error.message}`);
        return { reaped: false, reason: 'kill-failed' };
    }
    clearRecord(file);
    return { reaped: true, pid: record.pid };
}

module.exports = { reapOrphan, writeRecord, clearRecord, readRecord, imageName };
