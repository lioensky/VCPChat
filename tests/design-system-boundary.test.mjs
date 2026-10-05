import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('integrated boundary allows product work and rejects retained runtime, asset and CSS violations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-boundary-'));
    const guard = fileURLToPath(new URL('../scripts/check-design-system-boundary.mjs', import.meta.url));
    const write = (file, source = '') => {
        const target = path.resolve(root, file);
        assert.ok(target.startsWith(root + path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
    };
    const run = () => spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8', windowsHide: true });
    const reject = (file, source, expected) => {
        const existed = fs.existsSync(path.join(root, file));
        const previous = existed ? fs.readFileSync(path.join(root, file)) : null;
        write(file, source);
        const result = run();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, expected);
        if (existed) fs.writeFileSync(path.join(root, file), previous);
        else fs.unlinkSync(path.join(root, file));
    };
    try {
        for (const file of ['assets/font/Orbitron.ttf', 'assets/nova_button.png', 'assets/nova_button_light.png',
            'modules/topTabManager.js', 'modules/ui-system/lifecycle-scope.js', 'modules/services/deepWikiService.js',
            'modules/services/embeddedAppSessionManager.js', 'modules/ui-system/ask-nova-modal.js',
            'styles/ui-system/ask-nova.css', 'Notemodules/notes.html', 'Translatormodules/translator.html',
            'modules/event-listeners.js', 'modules/ui-system/appearance-studio.js']) write(file);
        write('styles/ui-next.css', '.shell { display: flex; }');
        write('styles/themes.css', ':focus-visible:not(#messageInput):not(.chat-message-input) { outline: 1px solid; }');
        write('modules/shared/embeddedAppAllowlist.js', ['open-notes-window', 'open-note-mini-window', 'open-translator-window',
            'open-memo-window', 'open-forum-window', 'open-log-window', 'open-themes-window', 'open-task-window',
            'open-plugin-manager-window'].map(action => `({ action: '${action}' });`).join('\n'));
        write('package.json', JSON.stringify({ scripts: {} }));
        write('modules/projectForgeBusiness.js', 'export const productFeature = true;');
        assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true }).status, 0);
        assert.equal(spawnSync('git', ['add', '.'], { cwd: root, windowsHide: true }).status, 0);
        const valid = run();
        assert.equal(valid.status, 0, valid.stderr);
        reject('agent-runtime/new.js', '', /forbidden Build\/Codex path/);
        reject('modules/projectForgeBusiness.js', "const channel = 'agent-runtime:spawn';", /forbidden Build\/Codex runtime/);
        reject('modules/services/embeddedAppSessionManager.js', 'const vcpApiKey = "secret";', /credentials/);
        reject('modules/services/embeddedAppSessionManager.js', 'webContents.executeJavaScript(code);', /post-load injection/);
        reject('styles/ui-system/new-component.css', '.component { background: url(./missing.png); }', /missing local CSS asset/);
        reject('styles/ui-system/new-component.css', '.shell { display: block; }', /duplicates.*shell authority/);
        reject('styles/themes.css', ':focus-visible { outline: 0; }', /composer focus contract|unscoped focus/);
        reject('package.json', JSON.stringify({ scripts: { test: 'node scripts/missing.mjs' } }), /references missing/);
        fs.unlinkSync(path.join(root, 'assets/nova_button.png'));
        const missing = run();
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /required development-tree design asset is missing/);
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('vcp-boundary-'));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
