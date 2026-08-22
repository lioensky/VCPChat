#!/usr/bin/env node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
    createRuntimeClosureManifest,
    validateRuntimePolicy,
    verifyDirectoryAgainstManifest,
} = require('../modules/bootstrap/runtime-closure');

function parseArguments(argv) {
    const options = { projectRoot: null, write: null, verify: null, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--project-root') options.projectRoot = argv[++index] || null;
        else if (argument === '--write') options.write = argv[++index] || null;
        else if (argument === '--verify') options.verify = argv[++index] || null;
        else if (argument === '--json') options.json = true;
        else throw new Error(`未知 runtime closure 参数：${argument}`);
    }
    return options;
}

export async function run(argv = process.argv.slice(2), io = process) {
    const options = parseArguments(argv);
    const projectRoot = path.resolve(options.projectRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const manifest = createRuntimeClosureManifest({ projectRoot });
    const policy = validateRuntimePolicy(manifest);
    let verification = { ok: true, failures: [] };
    if (options.verify) verification = verifyDirectoryAgainstManifest({ root: path.resolve(options.verify), manifest });
    if (options.write) {
        const outputPath = path.resolve(options.write);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    const result = { ok: policy.ok && verification.ok, manifest, policy, verification };
    if (options.json) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
        io.stdout.write(`VCPChat runtime closure：${result.ok ? '通过' : '失败'}\n`);
        io.stdout.write(`- 核心/供应链文件：${manifest.files.length}\n`);
        io.stdout.write(`- Electron：${manifest.electronVersion || 'unknown'}\n`);
        io.stdout.write(`- Rust runtime：${manifest.rustRuntime || 'degraded/absent'}\n`);
        [...policy.failures, ...verification.failures].forEach(item => io.stderr.write(`✗ ${item.path}: ${item.reason}\n`));
    }
    return result.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 2;
    });
}

export { parseArguments };
