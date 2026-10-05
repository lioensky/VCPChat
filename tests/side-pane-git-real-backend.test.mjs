import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { mountGitView } from '../modules/ui-system/side-pane/git/git-view.js';

const require = createRequire(import.meta.url);
const gitService = require('../modules/services/gitService.js');

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Mirrors modules/ipc/gitHandlers.js: { success, data } / { success: false, error, code }
function createBackedApi(workspaces, calls) {
    const wrap = async fn => {
        try {
            return { success: true, data: await fn() };
        } catch (error) {
            return { success: false, error: error.message, code: typeof error.code === 'string' ? error.code : null };
        }
    };
    const rootOf = id => workspaces.find(ws => ws.id === id).path;
    return {
        gitListWorkspaces: () => wrap(() => ({ workspaces, activeWorkspaceId: workspaces[0]?.id || null })),
        gitStatus: id => wrap(() => gitService.getStatus(rootOf(id))),
        gitDiff: (id, rel, options = {}) => wrap(() => gitService.getDiff(rootOf(id), rel, options)),
        gitStage: (id, paths) => wrap(() => gitService.stage(rootOf(id), paths)),
        gitUnstage: (id, paths) => wrap(() => gitService.unstage(rootOf(id), paths)),
        gitDiscard: (id, paths) => wrap(() => gitService.discard(rootOf(id), paths)),
        gitCommit: (id, payload) => wrap(() => gitService.commit(rootOf(id), payload)),
        gitPush: (id, payload) => {
            calls.push(payload);
            return wrap(() => gitService.push(rootOf(id), payload));
        },
    };
}

const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) return;
        await tick(50);
    }
}

test('the Git view lists and diffs the changes of a real repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-side-'));
    const repo = path.join(root, 'repo');
    const remote = path.join(root, 'remote.git');
    fs.mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    git(repo, 'remote', 'add', 'origin', remote);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n');

    const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
    const view = dom.window.document.getElementById('host');
    const api = createBackedApi([{ id: 'ws1', alias: 'demo', path: repo }], []);
    const handle = mountGitView(view, { api });
    await handle.ready;
    const paths = () => [...view.querySelectorAll('.side-git-card')].map(card => card.dataset.path).sort();
    const pick = (source) => {
        const select = view.querySelector('.side-git-source-select');
        select.value = source;
        select.dispatchEvent(new dom.window.Event('change'));
    };

    try {
        // unstaged source: the modified and the untracked file, flat
        assert.deepEqual(paths(), ['a.txt', 'new.txt']);

        // +N/-N show up on the collapsed row, computed from the real diff
        await waitFor(() => view.querySelector('[data-path="a.txt"] .text-diff-added'));
        assert.equal(view.querySelector('[data-path="a.txt"] .text-diff-added').textContent, '+1');
        assert.equal(view.querySelector('[data-path="a.txt"] .text-diff-removed').textContent, '-0');

        // expanding renders the real diff with the added line
        view.querySelector('[data-path="a.txt"] .side-git-row').click();
        await waitFor(() => view.querySelector('[data-path="a.txt"] .side-git-diff-table'));
        const addedRows = [...view.querySelectorAll('[data-path="a.txt"] tr.diff-line.add .diff-content')].map(td => td.textContent);
        assert.deepEqual(addedRows, ['+three']);

        // staged elsewhere (terminal / status panel) -> the tab follows on refresh
        git(repo, 'add', 'a.txt');
        await handle.refresh();
        assert.deepEqual(paths(), ['new.txt']);
        pick('staged');
        await waitFor(() => paths().join() === 'a.txt');
        assert.deepEqual(paths(), ['a.txt']);

        // nothing staged after a commit -> ZCode-style empty state
        git(repo, 'commit', '-m', 'feat: update a');
        await handle.refresh();
        assert.equal(paths().length, 0);
        assert.equal(view.querySelector('.side-git-empty').hidden, false);
        assert.equal(view.querySelector('.side-git-empty-title').textContent, '当前来源下没有可展示的改动');
    } finally {
        await handle.dispose();
        try {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (_error) {
            // Windows may briefly hold the temp dir; leaving it behind is harmless.
        }
    }
});

test('the Git view shows an add-workspace action when none are registered', async () => {
    const dom = new JSDOM('<div id="host"></div>');
    const view = dom.window.document.getElementById('host');
    const handle = mountGitView(view, {
        api: {
            gitListWorkspaces: async () => ({ success: true, data: { workspaces: [], activeWorkspaceId: null } }),
        },
    });
    await handle.ready;
    try {
        assert.ok(view.querySelector('.side-git-empty-add'));
        assert.equal(view.querySelector('.side-git-empty-title').textContent, '还没有工作区');
    } finally {
        await handle.dispose();
    }
});
