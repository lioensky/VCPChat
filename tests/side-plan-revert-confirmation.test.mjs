import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { createPlanDetailSideProvider, planTabId } from '../modules/ui-system/side-pane/planDetailSideProvider.js';

const require = createRequire(import.meta.url);
const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService.js');
const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('side plan did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

async function fixture(t, { absent = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'side-plan-revert-'));
    const workspace = { id: 'private', alias: 'private', path: root + '/workspace', enabled: true };
    fs.mkdirSync(workspace.path);
    forge.initialize({ dbPath: root + '/pf.db', services: { workspaceService: { list: () => [workspace], getActiveWorkspaceId: () => workspace.id } }, logger: { log() {}, warn() {}, error() {} } });
    const dom = new JSDOM('<div id="view"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
    let handle;
    t.after(async () => { handle?.dispose(); dom.window.close(); await forge.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    const projectId = (await forge.processToolCall({ command: 'CreateProject', name: 'private', dir: 'project' })).details.project.id;
    await forge.processToolCall({ command: 'CreateFile', projectId, path: 'a.txt', content: 'v1\n', reason: 'initial' });
    const nodeId = (await forge.processToolCall({ command: 'EditCode', projectId, path: 'a.txt', start: 1, end: 1, content: 'v2', reason: 'recorded edit' })).details.nodeId;
    const file = workspace.path + '/project/a.txt';
    if (absent) fs.unlinkSync(file);
    else fs.writeFileSync(file, 'manual content reviewed at confirmation\n');
    const calls = [], toasts = [];
    const wrap = fn => async (...args) => { try { return { success: true, data: await fn(...args) }; } catch (error) { return { success: false, error: error.message }; } };
    const api = {
        projectForgeListProjects: wrap(() => forge.gui.listProjects()),
        projectForgeGetProject: wrap(id => forge.gui.getProject(id)),
        projectForgeGetBatch: wrap((id, batch) => forge.gui.getBatchNodes(id, batch)),
        projectForgeGetNode: wrap((id, node) => forge.gui.getNodeDetail(id, node)),
        projectForgeRevertFile: wrap(args => { calls.push(args); return forge.gui.revertFileChange(args); }),
        onProjectForgeChanged: () => () => {},
    };
    const provider = createPlanDetailSideProvider({ document: dom.window.document, api, uiHelper: { showToastNotification: (message, type) => toasts.push({ message, type }) } });
    const view = dom.window.document.getElementById('view');
    handle = await provider.mountTab({ id: planTabId(projectId), payload: { projectId } }, view);
    view.querySelector('.side-plan-batch-head').click();
    await waitFor(() => view.querySelector(`[data-node-id="${nodeId}"]`));
    view.querySelector(`[data-node-id="${nodeId}"]`).click();
    await waitFor(() => view.querySelector('.side-plan-signature'));
    view.querySelector('.side-plan-signature').value = 'private user';
    const preview = async () => { view.querySelector('.side-plan-revert-before').click(); await waitFor(() => view.querySelector('.side-plan-revert-confirm')?.hidden === false && view.querySelector('.side-plan-revert-ok')); };
    const confirm = async () => { const count = toasts.length; view.querySelector('.side-plan-revert-ok').click(); await waitFor(() => toasts.length > count); };
    return { file, projectId, view, calls, toasts, preview, confirm };
}

for (const [change, absent] of [['edited', false], ['recreated', true], ['deleted', false]]) {
    test(`side confirmation preserves an external file change after its preview (${change})`, async t => {
        const f = await fixture(t, { absent });
        await f.preview();
        const batches = forge.gui.getProject(f.projectId).timeline.map(batch => batch.id);
        if (change === 'deleted') fs.unlinkSync(f.file);
        else fs.writeFileSync(f.file, 'new external content saved after preview\n');
        await f.confirm();
        if (change === 'deleted') assert.equal(fs.existsSync(f.file), false);
        else assert.equal(fs.readFileSync(f.file, 'utf8'), 'new external content saved after preview\n');
        assert.deepEqual(forge.gui.getProject(f.projectId).timeline.map(batch => batch.id), batches);
        assert.equal(f.toasts.at(-1).type, 'error');
        assert.match(f.toasts.at(-1).message, /确认期间发生变化/);
        assert.ok(f.view.querySelector('.side-plan-node'));
        assert.equal(f.calls[1].force, true);
        assert.equal(absent ? f.calls[1].expectedHash === null : /^[a-f0-9]{64}$/.test(f.calls[1].expectedHash), true);
        // A fresh preview and explicit confirmation can still perform the requested revert.
        await f.preview(); await f.confirm();
        assert.equal(fs.readFileSync(f.file, 'utf8'), 'v1\n');
        assert.equal(f.toasts.at(-1).type, 'success');
    });
}

test('an unchanged file can still be explicitly force-reverted from the side confirmation', async t => {
    const f = await fixture(t);
    await f.preview(); await f.confirm();
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'v1\n');
    assert.equal(f.toasts.at(-1).type, 'success');
    assert.match(f.calls[1].expectedHash, /^[a-f0-9]{64}$/);
    assert.equal(f.calls[1].force, true);
    assert.equal(f.view.querySelector('.side-plan-node'), null);
});
