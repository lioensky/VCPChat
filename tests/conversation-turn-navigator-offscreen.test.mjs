import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createOffscreenDomWindow } from '../modules/renderer/offscreenDomWindow.js';
import { readMessagePreviewText } from '../modules/renderer/messagePreviewText.js';
import {
    buildTurnNavigatorItems, collectTurnEntries, createConversationTurnNavigator,
} from '../modules/ui-system/conversation-turn-navigator.js';

const wait = () => new Promise(resolve => setTimeout(resolve, 240));

function fixture() {
    const dom = new JSDOM('<main><div class="chat-messages-container"><div id="chatMessages"></div></div></main>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    const scroller = root.parentElement;
    Object.defineProperty(scroller, 'clientWidth', { value: 900 });
    Object.defineProperty(scroller, 'clientHeight', { value: 600 });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
    const items = ['user', 'assistant', 'user', 'assistant'].map((role, i) => {
        const item = doc.createElement('article');
        item.className = `message-item ${role}`;
        item.dataset.messageId = `m${i}`;
        item.innerHTML = `<div class="md-content">${['问一', '答一', '问二', '答二'][i]}</div>`;
        item.getBoundingClientRect = () => ({ top: -6000, bottom: -5500, height: 500 });
        item.firstChild.getBoundingClientRect = () => ({ height: 400 });
        root.append(item);
        return item;
    });
    let restores = 0;
    let failRestore = false;
    const owner = createOffscreenDomWindow({
        batchSize: 10,
        canEvict: () => true,
        // Resource cleanup can change the body; snapshot must precede it.
        evict: item => item.firstChild.replaceChildren(),
        restore: async item => {
            restores++;
            if (failRestore) throw new Error('controlled preview restore failure');
            item.firstChild.textContent = `恢复${item.dataset.messageId}`;
        },
    });
    owner.initialize(scroller);
    const navigators = [];
    return {
        dom, doc, root, items, owner,
        get restores() { return restores; },
        set failRestore(value) { failRestore = value; },
        navigator() {
            const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root });
            navigators.push(navigator);
            navigator.mount();
            return navigator;
        },
        async evict() { items.forEach(owner.observe); await owner.check(); },
        close() { navigators.forEach(nav => nav.dispose()); owner.destroy(); dom.window.close(); },
    };
}

test('mounted navigator keeps question/answer previews after observed eviction; hover never restores bodies', async () => {
    const f = fixture();
    try {
        const navigator = f.navigator();
        const before = navigator.getItems();
        await f.evict();
        await wait(); // actual MutationObserver + debounce, not a manual dirty override
        assert.deepEqual(navigator.getItems(), before);
        assert.equal(f.owner.getStats().cold, 4);
        f.items.forEach(item => assert.equal(item.firstChild.childNodes.length, 0));
        f.doc.querySelector('.vcp-turn-nav-item').dispatchEvent(new f.dom.window.Event('pointerenter'));
        await wait();
        assert.equal(f.doc.querySelector('.vcp-turn-nav-card-user').textContent, '问一');
        assert.equal(f.doc.querySelector('.vcp-turn-nav-card-assistant').textContent, '答一');
        assert.equal(f.restores, 0);
        assert.equal(f.owner.getStats().cold, 4);
    } finally { f.close(); }
});

test('navigator mounted after eviction reads bounded snapshots with unchanged filtering/paragraph/truncation semantics', async () => {
    const f = fixture();
    try {
        f.items[0].firstChild.innerHTML = '  问 <b>一</b><details>隐藏</details><style>css</style><script>script</script>';
        f.items[1].firstChild.innerHTML = '<span class="thinking-indicator">思考中</span><div class="vcp-tool-use-bubble">工具参数</div>'
            + `${'甲'.repeat(220)}\n\n乙\n\n第三段${'长'.repeat(10000)}`;
        const before = buildTurnNavigatorItems(collectTurnEntries(f.root));
        await f.evict();
        const navigator = f.navigator();
        assert.deepEqual(navigator.getItems(), before);
        assert.equal(before[0].assistantPreview.length, 220);
        f.items.forEach(item => assert.ok(readMessagePreviewText(item).length <= 223));
        assert.equal(f.restores, 0);
    } finally { f.close(); }
});

test('restoration, edits and repeated eviction use current text, including clearing a previous answer', async () => {
    const f = fixture();
    try {
        const navigator = f.navigator();
        await f.evict();
        await wait();
        await f.owner.restoreAll();
        await wait();
        assert.equal(navigator.getItems()[0].assistantPreview, '恢复m1');
        f.items[0].firstChild.textContent = '编辑后的提问';
        f.items[1].firstChild.textContent = '';
        await wait();
        assert.equal(navigator.getItems()[0].userPreview, '编辑后的提问');
        assert.equal(navigator.getItems()[0].assistantPreviewKind, 'empty');
        // Scroll resumes cold scheduling after explicit restoreAll suspension.
        f.root.parentElement.dispatchEvent(new f.dom.window.Event('scroll'));
        await f.owner.check();
        await wait();
        assert.equal(navigator.getItems()[0].userPreview, '编辑后的提问');
        assert.equal(navigator.getItems()[0].assistantPreviewKind, 'empty');
        assert.equal(f.items[0].firstChild.childNodes.length, 0);
    } finally { f.close(); }
});

test('failed restoration retains preview; unobserve releases it and same-ID replacement cannot inherit it', async () => {
    const f = fixture();
    try {
        await f.evict();
        f.failRestore = true;
        await f.owner.restoreAll();
        assert.equal(readMessagePreviewText(f.items[1]), '答一');
        const replacement = f.items[1].cloneNode(true);
        assert.equal(readMessagePreviewText(replacement), '', 'snapshot belongs to a body instance, not ID or attributes');
        f.owner.unobserve(f.items[1]);
        // Reintroducing only the marker must not resurrect the released snapshot.
        f.items[1].dataset.vcpDomEvicted = 'true';
        assert.equal(readMessagePreviewText(f.items[1]), '');
        f.owner.destroy();
        assert.equal(readMessagePreviewText(f.items[0]), '');
    } finally { f.close(); }
});

test('independent roots with the same message IDs never share previews', async () => {
    const a = fixture();
    const b = fixture();
    try {
        b.items[1].firstChild.textContent = '另一个窗口的回答';
        await a.evict();
        await b.evict();
        assert.equal(a.navigator().getItems()[0].assistantPreview, '答一');
        assert.equal(b.navigator().getItems()[0].assistantPreview, '另一个窗口的回答');
    } finally { a.close(); b.close(); }
});