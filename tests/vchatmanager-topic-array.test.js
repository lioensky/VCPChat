'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const managerDir = path.resolve(__dirname, '../VchatManager');
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

async function writeJson(root, relativePath, value) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(value, null, 2), 'utf8');
}

// 与 VchatManager/main.js 的 fs:* 处理一致：读不到返回 null，列不出返回 []
function createApi(projectRoot) {
    const resolve = relativePath => path.join(projectRoot, relativePath);
    return {
        readFile: async relativePath => fs.readFile(resolve(relativePath), 'utf8').catch(() => null),
        listDir: async relativePath => fs.readdir(resolve(relativePath)).catch(() => []),
        writeFile: async (relativePath, content) => {
            await fs.writeFile(resolve(relativePath), content, 'utf8');
            return { success: true };
        },
        ensureDir: async relativePath => {
            await fs.mkdir(resolve(relativePath), { recursive: true });
            return { success: true };
        }
    };
}

async function openManager(t, projectRoot) {
    const html = await fs.readFile(path.join(managerDir, 'index.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    t.after(() => dom.window.close());
    dom.window.api = createApi(projectRoot);
    dom.window.alert = () => {};
    dom.window.confirm = () => true;
    // index.html 依次加载这两个脚本，二者共用顶层声明，因此合在一次 eval 里执行
    const scripts = await Promise.all(['consistency-checker.js', 'script.js']
        .map(file => fs.readFile(path.join(managerDir, file), 'utf8')));
    dom.window.eval(scripts.join('\n;\n'));
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await settle(80);
    return dom.window.document;
}

const FULL_ORDER = [
    { type: 'agent', id: 'agent_nova' }, { type: 'agent', id: 'agent_coco' }, { type: 'group', id: 'group_team' }
];

async function createProject(t, { combinedItemOrder = FULL_ORDER } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vchatmanager-topics-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await writeJson(root, 'AppData/settings.json', { combinedItemOrder });
    // 用户把较早的话题拖到了最前面：数组顺序与创建时间顺序不同
    await writeJson(root, 'AppData/Agents/agent_nova/config.json', {
        name: 'Nova',
        topics: [
            { id: 'topic_100', name: '置顶的旧话题', createdAt: 100, locked: true, unread: false, creatorSource: 'ui' },
            { id: 'topic_300', name: '最新话题', createdAt: 300, locked: true, unread: false, creatorSource: 'ui' },
            { id: 'topic_200', name: '中间话题', createdAt: 200, locked: true, unread: false, creatorSource: 'ui' }
        ]
    });
    await writeJson(root, 'AppData/Agents/agent_coco/config.json', { name: 'Coco', topics: [] });
    await writeJson(root, 'AppData/AgentGroups/group_team/config.json', {
        name: '协作组',
        topics: [{ id: 'group_topic_1', name: '主要群聊', createdAt: 1 }]
    });
    for (const id of ['topic_100', 'topic_300', 'topic_200']) {
        await writeJson(root, `AppData/UserData/agent_nova/topics/${id}/history.json`, []);
    }
    await writeJson(root, 'AppData/UserData/group_team/topics/group_topic_1/history.json', []);
    return root;
}

test('combinedItemOrder 为空或不全时，侧栏仍列出全部 Agent 和群组，已保存的顺序在前', async t => {
    const emptyOrder = await openManager(t, await createProject(t, { combinedItemOrder: [] }));
    const names = doc => [...doc.querySelectorAll('.sidebar-item span')].map(el => el.textContent);
    assert.deepEqual(names(emptyOrder), ['Coco', 'Nova', '协作组']);

    const partialOrder = await openManager(t, await createProject(t, {
        combinedItemOrder: [{ type: 'agent', id: 'agent_nova' }, { type: 'agent', id: 'agent_deleted' }]
    }));
    assert.deepEqual(names(partialOrder), ['Nova', 'Coco', '协作组']);
});

test('话题列表按 topics 数组的顺序显示，不按创建时间重排', async t => {
    const doc = await openManager(t, await createProject(t));
    doc.querySelector('.sidebar-item[data-id="agent_nova"]').click();
    const topics = [...doc.querySelectorAll('.topics-list li')].map(el => el.textContent);
    assert.deepEqual(topics, ['置顶的旧话题 (topic_100)', '最新话题 (topic_300)', '中间话题 (topic_200)']);
});
