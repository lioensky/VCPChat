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
    const topics = [...doc.querySelectorAll('.topics-list li .topic-label')].map(el => el.textContent);
    assert.deepEqual(topics, ['置顶的旧话题 (topic_100)', '最新话题 (topic_300)', '中间话题 (topic_200)']);
});

test('话题可以置顶、置底和拖动，保存后按新顺序写回 topics，话题对象原样保留', async t => {
    const root = await createProject(t);
    const doc = await openManager(t, root);
    const window = doc.defaultView;
    doc.querySelector('.sidebar-item[data-id="agent_nova"]').click();
    const ids = () => [...doc.querySelectorAll('.topics-list li')].map(el => el.dataset.topicId);
    const row = id => doc.querySelector(`.topics-list li[data-topic-id="${id}"]`);
    const saveButton = doc.querySelector('.topic-order-save');
    assert.equal(saveButton.disabled, true);

    row('topic_200').querySelector('.topic-move-top').click();
    assert.deepEqual(ids(), ['topic_200', 'topic_100', 'topic_300']);
    row('topic_100').querySelector('.topic-move-bottom').click();
    assert.deepEqual(ids(), ['topic_200', 'topic_300', 'topic_100']);
    // 把 topic_100 拖到 topic_300 上半部：放在它前面
    row('topic_100').dispatchEvent(new window.Event('dragstart'));
    const drop = new window.Event('drop', { cancelable: true });
    Object.defineProperty(drop, 'clientY', { value: -1 });
    row('topic_300').dispatchEvent(drop);
    assert.deepEqual(ids(), ['topic_200', 'topic_100', 'topic_300']);
    assert.equal(saveButton.disabled, false);

    // 本窗口打开后主程序又新建了一个话题，保存时不能丢，按新话题在前放在最前
    const configPath = path.join(root, 'AppData/Agents/agent_nova/config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.topics.unshift({ id: 'topic_400', name: '刚建的话题', createdAt: 400, locked: false, unread: true, creatorSource: 'ui' });
    config.model = 'kept-model';
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    saveButton.click();
    await settle(80);
    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(saved.topics.map(topic => topic.id), ['topic_400', 'topic_200', 'topic_100', 'topic_300']);
    assert.deepEqual(saved.topics[0], { id: 'topic_400', name: '刚建的话题', createdAt: 400, locked: false, unread: true, creatorSource: 'ui' });
    assert.equal(saved.model, 'kept-model');
    assert.deepEqual(ids(), ['topic_400', 'topic_200', 'topic_100', 'topic_300']);
    assert.equal(saveButton.disabled, true);
});

test('群组的话题顺序写回 AgentGroups 下的配置', async t => {
    const root = await createProject(t);
    const groupPath = path.join(root, 'AppData/AgentGroups/group_team/config.json');
    const group = JSON.parse(await fs.readFile(groupPath, 'utf8'));
    group.topics.push({ id: 'group_topic_2', name: '第二个群聊', createdAt: 2 });
    await fs.writeFile(groupPath, JSON.stringify(group, null, 2), 'utf8');

    const doc = await openManager(t, root);
    doc.querySelector('.sidebar-item[data-id="group_team"]').click();
    doc.querySelector('.topics-list li[data-topic-id="group_topic_2"] .topic-move-top').click();
    doc.querySelector('.topic-order-save').click();
    await settle(80);
    const saved = JSON.parse(await fs.readFile(groupPath, 'utf8'));
    assert.deepEqual(saved.topics.map(topic => topic.id), ['group_topic_2', 'group_topic_1']);
});

test('一致性检查跳过辅助对话目录，恢复的话题带上主程序的话题字段', async t => {
    const root = await createProject(t);
    const topicsDir = 'AppData/UserData/agent_nova/topics';
    await writeJson(root, `${topicsDir}/sidechat_1_ab12/history.json`, [{ id: 'm1', role: 'user', content: '侧聊', timestamp: 5 }]);
    await writeJson(root, `${topicsDir}/sidechat_1_ab12/sidechat-child.json`, {
        schemaVersion: 1, ephemeral: true, agentId: 'agent_nova', topicId: 'sidechat_1_ab12', parentTopicId: 'topic_100', createdAt: 5
    });
    await writeJson(root, `${topicsDir}/topic_lost/history.json`, [{ id: 'm2', role: 'user', content: '丢失的话题', timestamp: 400 }]);
    await writeJson(root, 'AppData/UserData/group_team/topics/group_topic_lost/history.json', [{ id: 'm3', role: 'user', content: '群聊', timestamp: 50 }]);

    const doc = await openManager(t, root);
    doc.getElementById('run-check-btn').click();
    await settle(80);
    const report = doc.getElementById('consistency-issues-list').textContent;
    assert.match(report, /topic_lost/);
    assert.doesNotMatch(report, /sidechat_1_ab12/);

    doc.getElementById('apply-fixes-btn').click();
    await settle(150);
    const agentConfig = JSON.parse(await fs.readFile(path.join(root, 'AppData/Agents/agent_nova/config.json'), 'utf8'));
    assert.deepEqual(agentConfig.topics.map(topic => topic.id), ['topic_lost', 'topic_100', 'topic_300', 'topic_200']);
    assert.deepEqual(agentConfig.topics[0], {
        id: 'topic_lost', name: 'Recovered: topic_lost', createdAt: 400, locked: true, unread: false, creatorSource: 'recovery'
    });
    const groupConfig = JSON.parse(await fs.readFile(path.join(root, 'AppData/AgentGroups/group_team/config.json'), 'utf8'));
    assert.deepEqual(groupConfig.topics[0], { id: 'group_topic_lost', name: 'Recovered: group_topic_lost', createdAt: 50 });
});

test('恢复丢失配置的 Agent 时不把辅助对话当作话题', async t => {
    const root = await createProject(t);
    const topicsDir = 'AppData/UserData/agent_lost/topics';
    await writeJson(root, `${topicsDir}/topic_9/history.json`, [{ id: 'a', role: 'assistant', name: 'Lost', content: '在', timestamp: 9 }]);
    await writeJson(root, `${topicsDir}/sidechat_2_cd34/history.json`, [{ id: 'b', role: 'user', content: '侧聊', timestamp: 10 }]);
    await writeJson(root, `${topicsDir}/sidechat_2_cd34/sidechat-child.json`, {
        schemaVersion: 1, ephemeral: true, agentId: 'agent_lost', topicId: 'sidechat_2_cd34', parentTopicId: 'topic_9', createdAt: 10
    });

    const doc = await openManager(t, root);
    doc.getElementById('run-check-btn').click();
    await settle(80);
    doc.getElementById('apply-fixes-btn').click();
    await settle(150);
    const recovered = JSON.parse(await fs.readFile(path.join(root, 'AppData/Agents/agent_lost/config.json'), 'utf8'));
    assert.deepEqual(recovered.topics, [
        { id: 'topic_9', name: 'Recovered: topic_9', createdAt: 9, locked: true, unread: false, creatorSource: 'recovery' }
    ]);
});
