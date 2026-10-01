import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createConversationStatusPanel } from '../modules/ui-system/conversation-status-panel.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

const historyUsing = (projectId) => [{
    role: 'assistant',
    content: `<<<[TOOL_REQUEST]>>> tool_name:「始」ProjectForge「末」 projectId:「始」${projectId}「末」 <<<[END_TOOL_REQUEST]>>>`
}];

const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function makeDom(variant = null) {
    const dom = new JSDOM('<main class="main-content"><header></header></main>', { url: 'https://test.invalid' });
    if (variant) dom.window.localStorage.setItem('vcp-status-panel-variant', variant);
    return dom;
}

for (const outcome of ['resolve', 'reject']) {
    test(`late plan for conversation A (${outcome}) cannot overwrite the refreshed conversation B`, async () => {
        const dom = makeDom('panel');
        const pending = deferred();
        const started = deferred();
        let current = historyUsing('A');
        const panel = createConversationStatusPanel({
            document: dom.window.document,
            getHistory: () => current,
            api: {
                projectForgeListProjects: async () => ({ success: true, data: ['A', 'B'].map(id => ({ id, name: id, workspace_id: id })) }),
                gitListWorkspaces: async () => ({ success: true, data: { workspaces: ['A', 'B'].map(id => ({ id, alias: id, path: `/code/${id}` })) } }),
                gitChangeSummary: async (id) => ({ success: true, data: { files: 0, added: 0, removed: 0, branch: { head: id } } }),
                projectForgeGetProject: (id) => {
                    if (id === 'A') {
                        started.resolve();
                        return pending.promise;
                    }
                    return Promise.resolve({ success: true, data: { todos: [{ seq: 1, title: 'B-only-task', status: 'doing' }] } });
                }
            }
        });

        panel.mount();
        await started.promise;
        current = historyUsing('B');
        await panel.refresh();
        if (outcome === 'resolve') pending.resolve({ success: true, data: { todos: [{ seq: 1, title: 'A-old-task', status: 'doing' }] } });
        else pending.reject(new Error('old request failed'));
        await settle();
        panel.setVariant('mini');
        panel.setVariant('panel');

        const text = dom.window.document.body.textContent;
        assert.ok(text.includes('B-only-task'));
        assert.ok(!text.includes('A-old-task'));
        panel.dispose();
        dom.window.close();
    });
}

test('disposal drops a late workspace result without loading or mounting a plan', async () => {
    const dom = makeDom();
    const pending = deferred();
    const started = deferred();
    let planCalls = 0;
    const panel = createConversationStatusPanel({
        document: dom.window.document,
        api: {
            gitListWorkspaces: () => {
                started.resolve();
                return pending.promise;
            },
            projectForgeListProjects: async () => {
                planCalls += 1;
                return { success: true, data: [] };
            }
        }
    });

    panel.mount();
    await started.promise;
    panel.dispose();
    pending.resolve({ success: true, data: { workspaces: [{ id: 'late' }] } });
    await settle();

    assert.equal(planCalls, 0);
    assert.equal(dom.window.document.querySelector('.zc-scope'), null);
    dom.window.close();
});
