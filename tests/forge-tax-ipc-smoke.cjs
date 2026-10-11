'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ipc-')));
app.on('window-all-closed', () => {});
const service = require('../Gamemodules/forge-tax/service.cjs');
const plugin = require('../VCPDistributedServer/Plugin/ForgeTax/forge-tax-service');
async function call(args) {
    return service.executeTool({ maid: 'Kerr', ...args });
}
async function ready(win) {
    for (let i = 0; i < 100; i++) {
        if (await win.webContents.executeJavaScript('Boolean(window.forgeTaxGame)')) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('界面初始化超时');
}
app.whenReady().then(async () => {
    await assert.rejects(() => call({ command: 'StartGame', maid: '' }), /maid/);
    await assert.rejects(() => call({ command1: 'GetState', maid1: 'Nova' }), /顶层maid/);
    assert.equal((await call({ command: 'StartGame', seed: 4 })).ok, true);
    const textResult = await plugin.processToolCall({ maid: 'Kerr', command: 'GetState' }, {});
    assert.equal(textResult.content[0].type, 'text');
    assert.ok(textResult.content[0].text.includes('### 背包'));
    assert.ok(!textResult.content[0].text.includes('\"results\":'));
    assert.equal((await call({ command: 'GetState', maid: 'Nova' })).state, null);
    await service.openWindow('agent:Kerr');
    let win = BrowserWindow.getAllWindows()[0];
    await ready(win);
    const readOnly = await win.webContents.executeJavaScript(`(async () => {
        const result = await window.forgeTaxRemote.command({command:'Hammer',swordId:'s1',count:1});
        window.testUpdates = 0;
        window.forgeTaxRemote.onUpdate(() => window.testUpdates++);
        return { blocked:!result.ok, disabled:document.querySelector('[data-hits]').disabled };
    })()`);
    assert.deepEqual(readOnly, { blocked: true, disabled: true });
    const batch = await call({ command1: 'Hammer', swordId1: 's1', count1: 3, command2: 'GetState' });
    assert.equal(batch.ok, true);
    await new Promise(r => setTimeout(r, 50));
    const rendered = await win.webContents.executeJavaScript('({updates:window.testUpdates,revision:window.forgeTaxGame.getState().revision})');
    assert.equal(rendered.updates, 1);
    assert.equal(rendered.revision, batch.state.revision);
    win.destroy();
    const closedQuery = await call({ command: 'GetState' });
    assert.equal(closedQuery.state.revision, batch.state.revision);
    const resumed = await call({ command: 'StartGame', seed: 999 });
    assert.equal(resumed.results[0].resumed, true);
    assert.equal(resumed.state.seed, 4);
    assert.equal(resumed.state.revision, batch.state.revision);
    await service.openWindow('agent:Kerr');
    win = BrowserWindow.getAllWindows()[0]; await ready(win);
    assert.equal(await win.webContents.executeJavaScript('window.forgeTaxGame.getState().revision'), batch.state.revision);
    win.destroy();
    await service.openWindow();
    win = BrowserWindow.getAllWindows()[0]; await ready(win);
    const human = await win.webContents.executeJavaScript(`(async () => {
        const r = await window.forgeTaxGame.dispatch({type:'hammer',swordId:'s1',count:1});
        return {ok:r.ok,readOnly:(await window.forgeTaxRemote.getState()).readOnly};
    })()`);
    assert.deepEqual(human, { ok: true, readOnly: false });
    assert.equal((await call({ command: 'GetState' })).state.revision, batch.state.revision);
    console.log('FORGETAX_IPC_PASS', JSON.stringify({ readOnly, rendered, human }));
    service.cleanup(); app.exit(0);
}).catch(error => { console.error(error); service.cleanup(); app.exit(1); });
setTimeout(() => { console.error('IPC timeout'); app.exit(1); }, 25000).unref();