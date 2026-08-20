#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctorCli } from './vcpchat-doctor.mjs';
import { runManagedLauncher } from './vcpchat-dev-launcher.mjs';
import { runRepairCli } from './vcpchat-repair.mjs';

const COMMANDS = Object.freeze(['doctor', 'launch', 'repair', 'recovery-ui', 'runtime', 'update', 'evidence']);

function usage() {
    return [
        'VCPChat Managed Bootstrap（独立入口）',
        '',
        '用法：node scripts/vcpchat-bootstrap.mjs <command> [options]',
        '',
        '  doctor       只读环境诊断',
        '  launch       托管开发启动（不自动修复）',
        '  repair       展示或显式执行受控修复',
        '  recovery-ui  打开独立恢复界面',
        '  runtime      验证打包运行时闭包',
        '  update       执行独立版本目录更新',
        '  evidence     检查发布证据矩阵',
        '',
        '现有 npm start、BAT、VBS 和桌面启动路径不会调用此入口。',
    ].join('\n');
}

async function delegateScript(scriptName, args) {
    const module = await import(`./${scriptName}`);
    return module.default ? module.default(args) : module.run(args);
}

export async function runBootstrapCli(argv = process.argv.slice(2), io = process) {
    const [command, ...args] = argv;
    if (!command || command === '--help' || command === '-h') {
        io.stdout.write(`${usage()}\n`);
        return 0;
    }
    if (!COMMANDS.includes(command)) {
        io.stderr.write(`未知 Bootstrap command：${command}\n\n${usage()}\n`);
        return 2;
    }
    if (command === 'doctor') return runDoctorCli(args, io);
    if (command === 'launch') return runManagedLauncher({ argv: args, io });
    if (command === 'repair') return runRepairCli({ argv: args, io });
    const delegates = {
        'recovery-ui': 'vcpchat-recovery-ui.mjs',
        runtime: 'vcpchat-runtime-closure.mjs',
        update: 'vcpchat-update.mjs',
        evidence: 'vcpchat-release-evidence.mjs',
    };
    return delegateScript(delegates[command], args);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    runBootstrapCli().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 2;
    });
}

export { COMMANDS, usage };
