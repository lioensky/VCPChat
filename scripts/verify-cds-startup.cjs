'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { ChatDataServiceLifecycle } = require('../modules/services/chatDataService/lifecycle');
const { ChatDataServiceClient } = require('../modules/services/chatDataService/client');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-startup-smoke-'));
    const binaryPath = path.resolve(__dirname, '../rust_chat_data_service/target/release',
        process.platform === 'win32' ? 'vcp_chat_data_service.exe' : 'vcp_chat_data_service');
    const lifecycle = new ChatDataServiceLifecycle({
        appDataPath: root, binaryPath, notifyEnabled: false, tantivyEnabled: false
    });
    try {
        const stages = [];
        lifecycle.on('startup-progress', frame => stages.push(frame.stage));
        assert.ok(await lifecycle.start());
        assert.equal(lifecycle.isReady, true);
        for (const stage of ['database_open', 'integrity_check', 'integrity_complete',
            'database_ready', 'watcher_start', 'watcher_ready']) {
            assert.ok(stages.includes(stage), `missing stage ${stage}`);
        }
        await lifecycle.stop();
        console.log('PASS: opt-in progress + real health + shutdown');

        const env = { ...process.env };
        delete env.VCP_CDS_STARTUP_PROGRESS;
        const child = spawn(binaryPath, [
            '--app-data', root, '--port', '0',
            '--notify-enabled', 'false', '--tantivy-enabled', 'false'
        ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const exited = once(child, 'exit');
        const lines = [];
        const reader = readline.createInterface({ input: child.stdout });
        reader.on('line', line => lines.push(line));
        let watchdog;
        try {
            const handshake = await Promise.race([
                once(reader, 'line').then(([line]) => JSON.parse(line)),
                new Promise((_, reject) => {
                    watchdog = setTimeout(() => reject(new Error('legacy ready timed out')), 10000);
                }),
                exited.then(([code]) => { throw new Error(`legacy exited early: ${code}`); })
            ]);
            clearTimeout(watchdog);
            assert.equal(handshake.type, 'ready');
            const client = new ChatDataServiceClient(handshake);
            assert.ok(await client.health());
            await client.shutdown();
            await exited;
            assert.equal(lines.length, 1, 'legacy stdout must contain only ready');
            console.log('PASS: opt-out ready-only + real health + shutdown');
        } finally {
            clearTimeout(watchdog);
            reader.close();
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
                await exited;
            }
        }
    } finally {
        await lifecycle.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });