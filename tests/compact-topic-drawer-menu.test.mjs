import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const loadScript = (window, name) =>
    window.eval(fs.readFileSync(new URL(`../modules/${name}.js`, import.meta.url), 'utf8'));

test('compact drawer keeps its body-mounted menu alive through pointerdown', async t => {
    const dom = new JSDOM(`<!doctype html>
        <aside class="sidebar active avatar-only compact-topics-open">
            <div class="sidebar-compact-navigation">
                <button class="sidebar-compact-trigger"></button>
                <div class="sidebar-compact-menu">
                    <button class="sidebar-compact-menu-item" data-compact-action="topics"></button>
                </div>
            </div>
            <section id="tabContentTopics" class="compact-drawer-open" aria-hidden="false">
                <ul id="topicList"><li class="topic-item"><span class="topic-name">Example</span></li></ul>
            </section>
        </aside>
        <button id="outside">Outside</button>`, {
        url: 'https://vcpchat.local/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    const { document } = window;
    t.after(() => window.close());
    loadScript(window, 'uiManager');
    loadScript(window, 'topicListManager');

    const sidebar = document.querySelector('.sidebar');
    const panel = document.getElementById('tabContentTopics');
    const row = panel.querySelector('.topic-item');
    const topic = { id: 'topic-42', name: 'Example' };
    const agent = { id: 'agent-1', type: 'agent', topics: [topic] };
    const writes = [];
    Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async text => { writes.push(text); } },
    });

    window.topicListManager.init({
        elements: { topicListContainer: panel },
        electronAPI: {},
        chatRepository: {},
        refs: {
            currentSelectedItemRef: { get: () => agent },
            currentTopicIdRef: { get: () => topic.id },
        },
        uiHelper: { showToastNotification() {} },
        mainRendererFunctions: {},
        topicSelectionReadiness: {},
    });
    await window.uiManager.init({
        electronAPI: { setTheme() {} },
        refs: { globalSettingsRef: { get: () => ({ currentThemeMode: 'light' }) } },
        elements: { leftSidebar: sidebar },
    });

    const showMenu = () => {
        window.topicListManager.showTopicContextMenu({ clientX: 100, clientY: 100 }, row, agent, topic, 'agent');
        return document.getElementById('topicContextMenu');
    };
    const pointerDown = target =>
        target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));

    const menu = showMenu();
    assert.equal(menu.parentElement, document.body);
    const copy = [...menu.querySelectorAll('.context-menu-item')]
        .find(item => item.textContent.includes('复制话题ID'));
    const icon = copy.querySelector('i');
    pointerDown(icon);
    assert.equal(menu.isConnected, true, 'pointerdown on a menu descendant must not tear it down');
    assert.equal(panel.classList.contains('compact-drawer-open'), true);
    icon.click();
    assert.deepEqual(writes, ['topic-42']);
    assert.equal(menu.isConnected, false, 'the action closes its own menu');
    assert.equal(panel.classList.contains('compact-drawer-open'), true);

    const reopenedMenu = showMenu();
    pointerDown(document.getElementById('outside'));
    assert.equal(panel.getAttribute('aria-hidden'), 'true');
    assert.equal(sidebar.classList.contains('compact-topics-open'), false);
    assert.equal(reopenedMenu.isConnected, false, 'closing the drawer tears down its menu');
    assert.equal(row.isConnected, false);
    window.topicListManager.dispose();
    await window.uiManager.dispose();
});