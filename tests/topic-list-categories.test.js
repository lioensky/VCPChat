const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/topicListManager.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function mountTopicList({ item, electronAPI, uiHelper = {} }) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <section id="tabContentTopics">
            <div class="topics-header-container">
                <button id="nextUiCreateTopicBtn" type="button"></button>
                <button id="nextUiManageTopicsBtn" type="button"></button>
                <button id="nextUiTopicSearchTrigger" type="button"></button>
                <button id="nextUiTopicSearchClose" type="button"></button>
                <button id="nextUiSelectAllTopicsBtn" type="button"><span class="vcp-ui-icon"></span></button>
                <button id="nextUiCategorizeTopicsBtn" type="button" disabled></button>
                <button id="nextUiDeleteTopicsBtn" type="button" disabled></button>
                <button id="nextUiExitTopicManageBtn" type="button"></button>
                <span id="nextUiTopicSelectionCount"></span>
                <input type="text" id="topicSearchInput">
            </div>
            <div class="next-ui-topic-manage-panel" aria-hidden="true"></div>
            <div class="sidebar-list-scroll">
                <ul id="topicList" class="topic-list"></ul>
            </div>
        </section>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' });
    const { window } = dom;
    window.requestAnimationFrame = callback => setTimeout(callback, 0);
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(source);
    window.topicListManager.init({
        elements: { topicListContainer: window.document.getElementById('tabContentTopics') },
        electronAPI,
        chatRepository: { getHistory: async () => [] },
        refs: {
            currentSelectedItemRef: { get: () => item },
            currentTopicIdRef: { get: () => null }
        },
        uiHelper,
        mainRendererFunctions: { updateCurrentItemConfig: () => {} },
        topicSelectionReadiness: { isReady: () => true, defer() {} }
    });
    window.topicListManager.setupTopicSearch();
    return { dom, window, list: window.document.getElementById('topicList') };
}

function renderedTopicIds(list) {
    return [...list.querySelectorAll('.topic-item')].map(item => item.dataset.topicId);
}

function categoryChips(window) {
    return [...window.document.querySelectorAll('.topic-category-chip')].map(chip => ({
        value: chip.dataset.topicCategoryFilter,
        label: chip.querySelector('.topic-category-name')?.textContent,
        count: chip.querySelector('.topic-category-count')?.textContent,
        active: chip.classList.contains('active')
    }));
}

function categoryConfig() {
    return {
        id: 'agent-a',
        topics: [
            { id: 't1', name: '论文一', category: '论文', createdAt: 1 },
            { id: 't2', name: '论文二', category: '论文', createdAt: 2 },
            { id: 't3', name: '工作一', category: '工作', createdAt: 3 },
            { id: 't4', name: '杂项', createdAt: 4 }
        ]
    };
}

test('话题分类筛选条按分类聚合计数，点击后只显示该分类的话题', async () => {
    const config = categoryConfig();
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    const bar = window.document.querySelector('.topic-category-bar');
    assert.ok(bar, '有分类时必须出现筛选条');
    assert.deepEqual(categoryChips(window), [
        { value: '__all__', label: '全部', count: '4', active: true },
        { value: '论文', label: '论文', count: '2', active: false },
        { value: '工作', label: '工作', count: '1', active: false },
        { value: '__uncategorized__', label: '未分类', count: '1', active: false }
    ]);
    assert.deepEqual(renderedTopicIds(list), ['t1', 't2', 't3', 't4']);

    const paperChip = window.document.querySelector('.topic-category-chip[data-topic-category-filter="论文"]');
    paperChip.click();
    await wait(30);

    assert.deepEqual(renderedTopicIds(list), ['t1', 't2'], '筛选后只渲染该分类的话题');
    assert.equal(
        window.document.querySelector('.topic-category-chip.active')?.dataset.topicCategoryFilter,
        '论文'
    );

    window.topicListManager.dispose();
    dom.window.close();
});

test('没有分类的话题时不渲染筛选条，保持原列表', async () => {
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => ({ topics: [{ id: 't1', name: '唯一话题', createdAt: 1 }] }),
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    assert.equal(window.document.querySelector('.topic-category-bar'), null);
    assert.deepEqual(renderedTopicIds(list), ['t1']);

    window.topicListManager.dispose();
    dom.window.close();
});

test('右键“设置分类”通过 IPC 保存，并立即刷新分类计数', async () => {
    const config = categoryConfig();
    const calls = [];
    const toasts = [];
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] }),
            setAgentTopicCategory: async (agentId, topicId, category) => {
                calls.push({ agentId, topicIds: [topicId], category });
                return { success: true, category };
            },
            setAgentTopicsCategory: async (agentId, topicIds, category) => {
                calls.push({ agentId, topicIds, category });
                return { success: true, category, topicIds };
            }
        },
        uiHelper: { showToastNotification: (message, type) => toasts.push({ message, type }) }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    const target = list.querySelector('.topic-item[data-topic-id="t4"]');
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    const menu = window.document.getElementById('topicContextMenu');
    assert.ok(menu, '右键菜单必须打开');
    const categoryItem = [...menu.querySelectorAll('.context-menu-item')]
        .find(item => item.textContent.includes('设置分类'));
    assert.ok(categoryItem, '右键菜单必须有设置分类');
    categoryItem.click();

    const dialog = window.document.querySelector('.topic-category-dialog');
    assert.ok(dialog, '设置分类对话框必须打开');
    const input = dialog.querySelector('.topic-category-input');
    input.value = '工作';
    dialog.querySelector('.confirm-dialog-confirm').click();
    await wait(40);

    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ agentId: 'agent-a', topicIds: ['t4'], category: '工作' }]);
    assert.equal(window.document.querySelector('.topic-category-dialog'), null, '保存后对话框应关闭');
    assert.ok(toasts.some(toast => toast.message.includes('工作')), '保存成功应有提示');
    assert.deepEqual(categoryChips(window).map(chip => [chip.label, chip.count]), [
        ['全部', '4'],
        ['论文', '2'],
        ['工作', '2']
    ]);

    window.topicListManager.dispose();
    dom.window.close();
});

test('分类条溢出时显示左右滚动按钮和滚动条状态', async () => {
    const config = {
        id: 'agent-a',
        topics: Array.from({ length: 12 }, (_, index) => ({
            id: `t${index + 1}`,
            name: `话题 ${index + 1}`,
            category: `分类-${index + 1}`,
            createdAt: index + 1
        }))
    };
    const { dom, window } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(30);

    const wrap = window.document.querySelector('.topic-category-bar-wrap');
    const bar = wrap.querySelector('.topic-category-bar');
    const left = wrap.querySelector('.topic-category-scroll-btn.is-left');
    const right = wrap.querySelector('.topic-category-scroll-btn.is-right');
    assert.ok(wrap && bar && left && right, '必须渲染滚动容器和按钮');

    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 120 });
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: 600 });
    bar.scrollLeft = 0;
    bar.__updateCategoryScrollState();

    assert.equal(wrap.classList.contains('has-overflow'), true);
    assert.equal(wrap.classList.contains('can-scroll-right'), true);
    assert.equal(wrap.classList.contains('can-scroll-left'), false);
    assert.equal(left.disabled, true);
    assert.equal(right.disabled, false);

    right.click();
    assert.ok(bar.scrollLeft > 0, '点击右箭头必须横向滚动');
    assert.equal(left.disabled, false);

    bar.scrollLeft = 300;
    bar.__updateCategoryScrollState();
    assert.equal(left.disabled, false);
    assert.equal(right.disabled, false);

    bar.scrollLeft = 480;
    bar.__updateCategoryScrollState();
    assert.equal(right.disabled, true);

    window.topicListManager.dispose();
    dom.window.close();
});

test('管理模式可批量选择话题并一次性设置分类', async () => {
    const config = categoryConfig();
    const calls = [];
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] }),
            setAgentTopicsCategory: async (agentId, topicIds, category) => {
                calls.push({ agentId, topicIds, category });
                return { success: true, category, topicIds };
            }
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    window.document.getElementById('nextUiManageTopicsBtn').click();
    list.querySelector('.topic-item[data-topic-id="t1"]').click();
    list.querySelector('.topic-item[data-topic-id="t3"]').click();

    const categorizeButton = window.document.getElementById('nextUiCategorizeTopicsBtn');
    assert.equal(categorizeButton.disabled, false, '有选择时批量分类按钮必须可用');
    categorizeButton.click();

    const dialog = window.document.querySelector('.topic-category-dialog');
    assert.ok(dialog, '批量分类对话框必须打开');
    assert.ok(dialog.textContent.includes('批量设置话题分类'));
    assert.ok(dialog.textContent.includes('2 个话题'));

    dialog.querySelector('.topic-category-input').value = '归档';
    dialog.querySelector('.confirm-dialog-confirm').click();
    await wait(50);

    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ agentId: 'agent-a', topicIds: ['t1', 't3'], category: '归档' }]);
    assert.deepEqual(categoryChips(window).map(chip => [chip.label, chip.count]), [
        ['全部', '4'],
        ['归档', '2'],
        ['论文', '1'],
        ['未分类', '1']
    ]);

    window.topicListManager.dispose();
    dom.window.close();
});

test('快速重复点击保存只发出一次分类请求', async () => {
    const config = categoryConfig();
    const calls = [];
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] }),
            setAgentTopicsCategory: async (agentId, topicIds, category) => {
                calls.push({ agentId, topicIds, category });
                await wait(20);
                return { success: true, category, topicIds };
            }
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    list.querySelector('.topic-item[data-topic-id="t4"]')
        .dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    [...window.document.querySelectorAll('#topicContextMenu .context-menu-item')]
        .find(item => item.textContent.includes('设置分类'))
        .click();

    const dialog = window.document.querySelector('.topic-category-dialog');
    dialog.querySelector('.topic-category-input').value = '去重';
    const saveButton = dialog.querySelector('.confirm-dialog-confirm');
    saveButton.click();
    saveButton.click();
    saveButton.click();
    await wait(60);

    assert.equal(calls.length, 1, '忙碌期间重复点击不能重复提交');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].topicIds)), ['t4']);

    window.topicListManager.dispose();
    dom.window.close();
});

test('连续快速切换分类时以最后一次点击为准', async () => {
    const config = categoryConfig();
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    window.document.querySelector('.topic-category-chip[data-topic-category-filter="论文"]').click();
    window.document.querySelector('.topic-category-chip[data-topic-category-filter="工作"]').click();
    await wait(80);

    assert.equal(
        window.document.querySelector('.topic-category-chip.active')?.dataset.topicCategoryFilter,
        '工作'
    );
    assert.deepEqual(renderedTopicIds(list), ['t3']);

    window.topicListManager.dispose();
    dom.window.close();
});

test('较慢的旧分类请求不能覆盖最后一次选择', async () => {
    const config = categoryConfig();
    let configCalls = 0;
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => {
                configCalls += 1;
                const delay = configCalls === 2 ? 80 : configCalls === 3 ? 10 : 0;
                await wait(delay);
                return config;
            },
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    window.document.querySelector('.topic-category-chip[data-topic-category-filter="论文"]').click();
    window.document.querySelector('.topic-category-chip[data-topic-category-filter="工作"]').click();
    await wait(150);

    assert.equal(
        window.document.querySelector('.topic-category-chip.active')?.dataset.topicCategoryFilter,
        '工作',
        '慢返回的旧请求不能把选中分类改回去'
    );
    assert.deepEqual(renderedTopicIds(list), ['t3']);

    window.topicListManager.dispose();
    dom.window.close();
});

test('本地记录的分类已不存在时回退到全部', async () => {
    const config = categoryConfig();
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });
    window.localStorage.setItem('vcpchat.topicCategoryFilter:agent:agent-a', '已删除的分类');

    await window.topicListManager.loadTopicList();
    await wait(20);

    assert.equal(
        window.document.querySelector('.topic-category-chip.active')?.dataset.topicCategoryFilter,
        '__all__'
    );
    assert.deepEqual(renderedTopicIds(list), ['t1', 't2', 't3', 't4']);

    window.topicListManager.dispose();
    dom.window.close();
});

test('把当前分类的话题批量移走后回退到全部并隐藏空分类', async () => {
    const config = categoryConfig();
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => config,
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] }),
            setAgentTopicsCategory: async (agentId, topicIds, category) => {
                const ids = new Set(topicIds);
                for (const topic of config.topics) {
                    if (!ids.has(topic.id)) continue;
                    if (category) topic.category = category;
                    else delete topic.category;
                }
                return { success: true, category, topicIds };
            }
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);
    window.document.querySelector('.topic-category-chip[data-topic-category-filter="论文"]').click();
    await wait(40);

    window.document.getElementById('nextUiManageTopicsBtn').click();
    window.document.getElementById('nextUiSelectAllTopicsBtn').click();
    window.document.getElementById('nextUiCategorizeTopicsBtn').click();

    const dialog = window.document.querySelector('.topic-category-dialog');
    dialog.querySelector('.topic-category-input').value = '工作';
    dialog.querySelector('.confirm-dialog-confirm').click();
    await wait(80);

    assert.equal(window.document.querySelector('.topic-category-chip[data-topic-category-filter="论文"]'), null);
    assert.equal(
        window.document.querySelector('.topic-category-chip.active')?.dataset.topicCategoryFilter,
        '__all__'
    );
    assert.deepEqual(renderedTopicIds(list), ['t1', 't2', 't3', 't4']);

    window.topicListManager.dispose();
    dom.window.close();
});

test('分类名作为纯文本渲染，不能注入标记', async () => {
    const hostile = '<img src=x data-injected="category">';
    const { dom, window } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => ({
                id: 'agent-a',
                topics: [
                    { id: 't1', name: '恶意分类', category: hostile, createdAt: 1 },
                    { id: 't2', name: '普通话题', createdAt: 2 }
                ]
            }),
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });

    await window.topicListManager.loadTopicList();
    await wait(20);

    const chip = [...window.document.querySelectorAll('.topic-category-chip')]
        .find(item => item.textContent.includes(hostile));
    assert.ok(chip);
    assert.equal(window.document.querySelector('[data-injected]'), null);

    window.topicListManager.dispose();
    dom.window.close();
});
