import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const settings = { vcpServerUrl: 'http://localhost:6005/v1/chat/completions', vcpApiKey: 'test' };
const api = { loadSettings: async () => settings };
const text = '正文 「末」\n  第二行';
const date = '2026-11-28';
const input = value => ({ value });

function slice(path, start, end) {
    const source = read(path);
    const from = source.indexOf(start);
    assert.notEqual(from, -1, start);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, end);
    return source.slice(from, to);
}

function setup(globals = {}, { status = 200 } = {}) {
    const requests = [];
    const context = createContext({
        api, URL, setTimeout() {},
        alert(message) { assert.fail(message); },
        console: { log() {}, error() {} },
        fetch: async (url, init) => {
            requests.push({ url, ...init, headers: { ...init.headers }, body: JSON.parse(init.body) });
            return Response.json({ original_plugin_output: 'ok' }, { status });
        },
        ...globals
    });
    runInContext(read('modules/utils/vcpServerRoutes.js'), context);
    function check(name, args, signal) {
        assert.deepEqual(requests, [{
            url: 'http://localhost:6005/v1/human/tool', method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
            body: { name, arguments: args }, signal
        }]);
    }
    return { run: code => runInContext(code, context), check };
}

test('forum post passes the complete content and explicit author to JRC', async () => {
    const fields = {
        'post-title-input': input('标题'), 'post-board-input': input('板块'),
        'post-author-input': input('作者'), 'post-content-input': input(text)
    };
    let handler;
    const { run, check } = setup({
        submitPostBtn: { addEventListener: (_, callback) => { handler = callback; } },
        document: { getElementById: id => fields[id] },
        createPostModal: { style: {} }, loadPosts() {}, showError(_, message) { assert.fail(message); }
    });
    run(slice('Forummodules/forum.js', "submitPostBtn.addEventListener('click', async", 'function requestDeferredWork'));
    await handler();
    check('VCPForum', { command: 'CreatePost', maid: '作者', board: '板块', title: '标题', content: text });
});

test('regular note preserves a distinct folder and omits blank tags', async () => {
    const { run, check } = setup({
        newMemoDateInput: input(date), newMemoMaidInput: input('作者'), newMemoFilenameInput: input('文件'),
        newMemoTagsInput: input(''), newMemoContentInput: input(text), createModal: { style: {} },
        document: { getElementById: id => id === 'new-memo-folder' ? input('索引') : {} }
    });
    await run(slice('Memomodules/memo.js', 'async function handleCreateMemo()', 'async function searchMemos(') + '\nhandleCreateMemo()');
    check('DailyNote', { command: 'create', maid: '作者', folder: '索引', Date: date, fileName: '文件', Content: text });
});

test('integrated note preserves its destination, and HTTP failure never offers old-note deletion or retries', async () => {
    let error;
    const { run, check } = setup({
        memoWorkbenchApi: api, document: { getElementById: () => ({}) },
        alert(message) { error = message; },
        workbench: {
            newDateInput: input(date), newFolderInput: input('索引'), newFilenameInput: input(''),
            newTagsInput: input('标签'), newContentInput: input(text), selectedMemos: [],
            showPostPublishDialog() { assert.fail('must not offer to delete old notes on HTTP failure'); }
        }
    }, { status: 500 });
    const method = slice('Memomodules/memo-workbench.js', 'async handleCreateIntegratedMemo()', '// 显示发布后旧日记处理弹窗');
    await run(`Object.assign(workbench, { ${method} }).handleCreateIntegratedMemo()`);
    check('DailyNote', { command: 'create', maid: '索引', Date: date, Tag: '标签', Content: text });
    assert.match(error, /发布失败/);
});

test('memo semantic search forwards typed parameters and its AbortSignal', async () => {
    const searchAbortController = new AbortController();
    const { run, check } = setup({
        text, searchAbortController, extractLightMemoOutput: reply => reply.original_plugin_output,
        processSemanticSearchResults(output, query) { assert.equal(output, 'ok'); assert.equal(query, text); }
    });
    await run(slice('Memomodules/memo.js', 'async function performSemanticSearch(', 'function extractLightMemoOutput(') + '\nperformSemanticSearch(text)');
    check('LightMemo', { maid: 'Memo', query: text, k: 10, tag_boost: 0.6, search_all_knowledge_bases: true }, searchAbortController.signal);
});

test('music semantic search keeps its mode and gain', async () => {
    const app = { api, semanticSearchBtn: { classList: { add() {}, remove() {} } } };
    const { run, check } = setup({ app, text });
    run(read('Musicmodules/music-utils.js') + '\nsetupUtils(app)');
    app.processSemanticSearchResults = output => assert.equal(output, 'ok');
    await run('app.performSemanticSearch(text)');
    check('LightMemo', { maid: 'MusicPlay', query: `[音乐检索]${text}`, k: 10, tag_boost: 0.95 });
});
