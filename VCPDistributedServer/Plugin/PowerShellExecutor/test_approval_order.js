'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Exercise each production dispatcher. Replace the two UI/OS boundaries in
// this private module instance; never invoke helpers or open a real terminal.
function loadDispatcher(entry, confirm, elevate) {
    const m = new Module(entry, module);
    m.filename = entry;
    m.paths = Module._nodeModulePaths(path.dirname(entry));
    const real = Module.createRequire(entry);
    const denied = () => { throw new Error('Unexpected host operation in approval test'); };
    const fakeFs = Object.create(fs);
    fakeFs.existsSync = () => false;
    fakeFs.readFileSync = denied;
    m.require = id => {
        if (id === 'fs' || id === 'node:fs') return fakeFs;
        if (id === 'electron') return { BrowserWindow: class {}, ipcMain: { on(){}, handle(){} }, clipboard: {} };
        if (id === 'chokidar') return { watch: () => ({ on(){return this;}, close(){} }) };
        if (id === 'tmp') return { file: denied };
        if (['node-pty','child_process','node:child_process'].includes(id)) return { spawn: denied, execFile: denied, execSync: denied };
        if (id.endsWith('/commandSecurityCheck')) return {
            intelligentSecurityCheckAsync: async () => ({isForbidden:false, needsAuth:true}),
            shutdownAstDaemon(){}
        };
        if (id.endsWith('/secretRedactor')) return { refreshBeforeEgress(){}, redactSecrets:x=>x, redactToolResult:x=>x };
        if (id === './commandRunStore') return { COMMAND_RUN_RAW_LIMIT:65536, subscribeCommandRuns:()=>()=>{} };
        return real(id);
    };
    m.confirmForTest = confirm;
    m.elevateForTest = elevate;
    m._compile(fs.readFileSync(entry,'utf8') +
        '\nrequestInteractiveConfirmation = module.confirmForTest; executeAdminCommand = module.elevateForTest;\n', entry);
    return m.exports.processToolCall;
}

for (const name of ['PowerShellExecutor','MacPowerShell']) {
    for (const approved of [false,true]) {
        test(`${name}: ${approved ? 'confirmation precedes elevation' : 'cancellation prevents elevation'}`, async () => {
            const calls = [];
            const dispatch = loadDispatcher(path.resolve(__dirname,'..',name,`${name}.js`),
                async () => { calls.push('confirm'); return approved; },
                async () => { calls.push('admin'); return 'mock admin receipt'; });
            const receipt = await dispatch({command:'ExecutePowerShell',powershell:"Write-Output 'fixture'",requireAdmin:true});
            assert.deepEqual(calls, approved ? ['confirm','admin'] : ['confirm']);
            assert.ok(receipt.content[0].text.includes(approved ? 'mock admin receipt' : '用户取消了操作'));
        });
    }
}
