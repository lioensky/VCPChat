import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSettingsPage } = require('../modules/deskpet/settingsPage.js');

// 1x1 透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-drop-'));
    const agentDir = path.join(root, 'Agents');
    fs.mkdirSync(path.join(agentDir, 'A'), { recursive: true });
    let dialogs = 0;
    const electron = { ipcMain: { handle() {}, on() {} }, dialog: { showOpenDialog: async () => { dialogs += 1; return { canceled: true }; } }, shell: {} };
    const page = createSettingsPage({ electron, paths: { agentDir }, controls: {}, previews: {}, pets: { isAgentId: () => true, mainWindow: () => null } });
    return { root, agentDir, page, dialogs: () => dialogs };
}

test('dropped files import without opening the file picker', async () => {
    const env = setup();
    const art = path.join(env.root, 'drop');
    fs.mkdirSync(art);
    fs.writeFileSync(path.join(art, 'maid.png'), PNG);
    fs.writeFileSync(path.join(art, 'notes.txt'), 'x');
    const result = await env.page.importOutfit('A', [path.join(art, 'maid.png'), path.join(art, 'notes.txt')]);
    assert.equal(result.success, true, result.error);
    assert.equal(env.dialogs(), 0);
    const target = path.join(env.agentDir, 'A', 'deskpet', result.outfitId);
    assert.ok(fs.existsSync(path.join(target, 'maid.png')));
    assert.ok(!fs.existsSync(path.join(target, 'notes.txt')));
});

test('a dropped folder is copied as one outfit; relative, missing and unknown paths are refused', async () => {
    const env = setup();
    const folder = path.join(env.root, 'Nova');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'happy.png'), PNG);
    const result = await env.page.importOutfit('A', [folder]);
    assert.equal(result.success, true, result.error);
    assert.equal(result.outfitId, 'Nova');
    assert.ok(fs.existsSync(path.join(env.agentDir, 'A', 'deskpet', 'Nova', 'happy.png')));

    for (const files of [['happy.png'], [path.join(env.root, 'missing.png')], [path.join(folder, '..', 'nothing.txt')], []]) {
        const refused = await env.page.importOutfit('A', files);
        assert.equal(refused.success, false);
        assert.match(refused.error, /没认出来/);
    }
    assert.equal(env.dialogs(), 0);
});
