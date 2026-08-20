#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collectDoctorReport } = require('../modules/bootstrap/environment-doctor');

function parseArguments(argv) {
    const options = { json: false, deep: false, projectRoot: null };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json') options.json = true;
        else if (argument === '--deep') options.deep = true;
        else if (argument === '--project-root') options.projectRoot = argv[++index] || null;
        else if (argument === '--repair') throw new Error('M1 Doctor is read-only; --repair is not available before M3.');
        else throw new Error(`Unknown doctor argument: ${argument}`);
    }
    return options;
}

function renderHuman(report) {
    const icon = { pass: '✓', warn: '!', fail: '✗', skip: '·' };
    const lines = [
        `VCPChat Doctor — ${report.ok ? '可以托管启动' : '存在阻塞项'}`,
        `Project: ${report.projectRoot}`,
        `Platform: ${report.platform}-${report.arch}`,
        '',
        ...report.checks.map(item => `${icon[item.status] || '?'} ${item.id}: ${item.message}`),
        '',
        `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skip`,
    ];
    return lines.join('\n');
}

export function runDoctorCli(argv = process.argv.slice(2), io = process) {
    const options = parseArguments(argv);
    const projectRoot = path.resolve(options.projectRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const report = collectDoctorReport({ projectRoot, deep: options.deep });
    io.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderHuman(report)}\n`);
    return report.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = runDoctorCli();
    } catch (error) {
        process.stderr.write(`VCPChat Doctor failed: ${error.message}\n`);
        process.exitCode = 2;
    }
}

export { parseArguments, renderHuman };
