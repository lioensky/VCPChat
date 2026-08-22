#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OLD_ENTRYPOINTS = Object.freeze(['start.bat', 'start debug.bat', '启动Vchat.vbs', '启动全部.vbs', 'start-desktop.vbs', 'start-rag-observer.vbs']);

function hash(file) {
    let value = 0;
    for (const byte of fs.readFileSync(file)) value = ((value << 5) - value + byte) | 0;
    return String(value >>> 0);
}

function collectEvidence() {
    const missing = OLD_ENTRYPOINTS.filter(name => !fs.existsSync(path.join(root, name)));
    const workflows = fs.existsSync(path.join(root, '.github', 'workflows'))
        ? fs.readdirSync(path.join(root, '.github', 'workflows')).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
        : [];
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        oldEntrypoints: OLD_ENTRYPOINTS.map(name => ({ name, present: !missing.includes(name), hash: missing.includes(name) ? null : hash(path.join(root, name)) })),
        ci: {
            workflows,
            windowsRunnerDeclared: workflows.some(name => /windows/i.test(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'))),
            macRunnerDeclared: workflows.some(name => /macos/i.test(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'))),
            linuxRunnerDeclared: workflows.some(name => /ubuntu|linux/i.test(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'))),
        },
        externalEvidenceRequired: [
            'Windows PowerShell 5.1/7、中文/空格/长路径、NSIS 安装卸载',
            'macOS 签名/隔离属性与 arm64/x64',
            'Linux AppImage 冷启动',
            '断网、磁盘不足、睡眠恢复、30–60 分钟人工 soak',
        ],
        ok: missing.length === 0,
        missingEntrypoints: missing,
    };
}

export function run(argv = process.argv.slice(2), io = process) {
    const json = argv.includes('--json');
    const evidence = collectEvidence();
    if (json) io.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    else {
        io.stdout.write(`VCPChat 发布证据矩阵：${evidence.ok ? '基础检查通过' : '失败'}\n`);
        io.stdout.write(`- 旧入口完整性：${evidence.oldEntrypoints.filter(item => item.present).length}/${evidence.oldEntrypoints.length}\n`);
        io.stdout.write(`- CI runner：${evidence.ci.linuxRunnerDeclared ? 'Linux ' : ''}${evidence.ci.macRunnerDeclared ? 'macOS ' : ''}${evidence.ci.windowsRunnerDeclared ? 'Windows' : ''}\n`);
        io.stdout.write('- Windows 签名、安装包和人工 soak 仍需真实 runner 证据。\n');
    }
    return evidence.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    try { process.exitCode = run(); } catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 2; }
}

export { OLD_ENTRYPOINTS, collectEvidence };
