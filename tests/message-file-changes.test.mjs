import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { classifyToolFileOperations, parseToolFields, extractFileChanges, summarizeFileChanges, createMessageFileChanges } from '../modules/ui-system/message-file-changes.js';

const REQ = (body) => `<<<[TOOL_REQUEST]>>>\n${body}\n<<<[END_TOOL_REQUEST]>>>`;
const RES = (status) => `[[VCP调用结果信息汇总:- 工具名称: FileOperator\n- 执行状态: ${status}\n- 返回内容: okVCP调用结果结束]]`;
const write = (path) => REQ(`tool_name:「始」FileOperator「末」,\ncommand:「始」WriteFile「末」,\nfilePath:「始」${path}「末」,\ncontent:「始ESCAPE」hello 「末」 world「末ESCAPE」`);
const requestWrite = write;
const confirmed = text => text + '\n' + RES('success');
const command = (name, path) => REQ(`tool_name:「始」FileOperator「末」,\ncommand:「始」${name}「末」,\nfilePath:「始」${path}「末」,\ncontent:「始」z「末」`);

test('parseToolFields reads plain and ESCAPE fields without being cut by fake end markers', () => {
    const fields = parseToolFields('tool_name:「始」FileOperator「末」,\ncontent:「始ESCAPE」a「末」b「末ESCAPE」,\nfilePath:「始」C:/x.js「末」');
    assert.equal(fields.tool_name, 'FileOperator');
    assert.equal(fields.content, 'a「末」b');
    assert.equal(fields.filePath, 'C:/x.js');
});

test('extractFileChanges lists write/edit/delete/move operations and ignores reads and other tools', () => {
    const text = [
        '先看看。',
        command('ReadFile', 'C:/a.txt'),
        write('C:/proj/new.js'),
        REQ('tool_name:「始」FileOperator「末」,\ncommand:「始」ApplyDiff「末」,\nfilePath:「始」C:/proj/old.js「末」,\ntarget:「始」a「末」,\nreplace:「始」b「末」'),
        command('DeleteFile', 'C:/proj/gone.js'),
        REQ('tool_name:「始」FileOperator「末」,\ncommand:「始」MoveFile「末」,\nsourcePath:「始」C:/proj/a.js「末」,\ndestinationPath:「始」C:/proj/b.js「末」'),
        REQ('tool_name:「始」DailyNote「末」,\ncommand:「始」create「末」,\nContent:「始」x「末」')
    ].map(text => text.includes('tool_name:「始」FileOperator') ? confirmed(text) : text).join('\n');
    assert.deepEqual(extractFileChanges(text), [
        { path: 'C:/proj/new.js', op: 'write' },
        { path: 'C:/proj/old.js', op: 'edit' },
        { path: 'C:/proj/gone.js', op: 'delete' },
        { path: 'C:/proj/a.js', op: 'move', to: 'C:/proj/b.js' }
    ]);
    assert.equal(summarizeFileChanges(extractFileChanges(text)), '本轮改动 4 个文件');
    assert.equal(summarizeFileChanges([]), '');
});

test('batch requests (command1/filePath1…) are expanded', () => {
    const text = REQ('tool_name:「始」FileOperator「末」,\ncommand1:「始」WriteFile「末」,\nfilePath1:「始」C:/a.js「末」,\ncontent1:「始」x「末」,\ncommand2:「始」AppendFile「末」,\nfilePath2:「始」C:/b.log「末」,\ncontent2:「始」y「末」');
    assert.deepEqual(extractFileChanges(confirmed(text)), [{ path: 'C:/a.js', op: 'write' }, { path: 'C:/b.log', op: 'append' }]);
});

test('same path collapses to one entry: write beats edit, a later delete wins', () => {
    const edit = command('EditFile', 'C:/a.js');
    const del = command('DeleteFile', 'C:/a.js');
    assert.deepEqual(extractFileChanges([edit, write('C:/a.js'), edit].map(confirmed).join('\n')), [{ path: 'C:/a.js', op: 'write' }]);
    assert.deepEqual(extractFileChanges([write('C:/a.js'), del].map(confirmed).join('\n')), [{ path: 'C:/a.js', op: 'delete' }]);
});

test('failed and unconfirmed calls are never claimed as file changes', () => {
    const text = [write('C:/ok.js'), RES('success'), write('C:/bad.js'), RES('error')].join('\n');
    assert.deepEqual(extractFileChanges(text), [{ path: 'C:/ok.js', op: 'write' }]);
    const unpaired = [write('C:/one.js'), write('C:/two.js'), RES('error')].join('\n');
    assert.deepEqual(extractFileChanges(unpaired), []);
    assert.deepEqual(extractFileChanges(write('C:/pending.js')), []);
});

test('tool requests quoted inside code fences are not file changes', () => {
    const text = '示例：\n```\n' + write('C:/example.js') + '\n```\n';
    assert.deepEqual(extractFileChanges(text), []);
    assert.deepEqual(extractFileChanges(''), []);
    assert.deepEqual(extractFileChanges(null), []);
});

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

function makeApp(content, options = {}) {
    const dom = new JSDOM('<div id="chatMessages"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    const opened = [];
    const controller = createMessageFileChanges({
        document: doc,
        messagesRoot: root,
        getHistory: () => [{ id: 'm1', role: 'assistant', content }],
        openFile: path => opened.push(path),
        ...options
    });
    controller.mount();
    const add = (cls = 'message-item assistant') => {
        const item = doc.createElement('div');
        item.className = cls;
        item.dataset.messageId = 'm1';
        item.innerHTML = '<img class="chat-avatar"><div class="details-and-bubble-wrapper"><div class="name-time-block"></div><div class="md-content">x</div></div>';
        root.appendChild(item);
        return item;
    };
    return { dom, doc, root, controller, opened, add };
}

test('renders a collapsible summary after streaming ends and opens files on click', async () => {
    const content = [write('C:/proj/src/new.js'), command('DeleteFile', 'C:/proj/gone.js')].map(confirmed).join('\n');
    const { root, add, opened } = makeApp(content);
    const item = add('message-item assistant streaming');
    await wait();
    assert.equal(root.querySelector('.vcp-file-changes'), null, 'not while streaming');
    item.classList.remove('streaming');
    await wait();
    const panel = root.querySelector('.details-and-bubble-wrapper > .vcp-file-changes');
    assert.ok(panel);
    assert.equal(panel.querySelector('summary').textContent, '本轮改动 2 个文件');
    const rows = [...panel.querySelectorAll('li')];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('.vcp-file-changes-op').textContent, '写入');
    assert.equal(rows[0].querySelector('.vcp-file-changes-path').textContent, 'new.js');
    assert.equal(rows[0].querySelector('.vcp-file-changes-dir').textContent, 'C:/proj/src');
    rows[0].querySelector('button').click();
    assert.deepEqual(opened, ['C:/proj/src/new.js']);
    assert.equal(rows[1].querySelector('button'), null, 'deleted files cannot be opened');
    item.classList.add('streaming');
    item.classList.remove('streaming');
    await wait();
    assert.equal(root.querySelectorAll('.vcp-file-changes').length, 1, 'no duplicate panel');
});

test('inside a workspace the directory is shown relative to it, and files at its root show none', async () => {
    const content = [write('C:/proj/src/new.js'), write('C:/proj/top.js'), write('D:/elsewhere/x.js')].map(confirmed).join('\n');
    const relativePath = (path) => (path.startsWith('C:/proj/') ? path.slice('C:/proj/'.length) : null);
    const { root, add, opened } = makeApp(content, { relativePath });
    add();
    await wait();
    const rows = [...root.querySelectorAll('.vcp-file-changes li')];
    assert.deepEqual(rows.map(row => row.querySelector('.vcp-file-changes-dir').textContent), ['src', '', 'D:/elsewhere']);
    assert.equal(rows[0].querySelector('.vcp-file-changes-dir').title, 'C:/proj/src/new.js', 'the full path stays in the tooltip');
    rows[1].querySelector('button').click();
    assert.deepEqual(opened, ['C:/proj/top.js'], 'files still open by their absolute path');
});

test('messages without file changes get nothing; dispose is idempotent', async () => {
    const { root, add, controller } = makeApp('只是聊天，没有改文件。');
    add();
    await wait();
    assert.equal(root.querySelector('.vcp-file-changes'), null);
    controller.dispose();
    controller.dispose();
});

test('attempt state distinguishes success, failure, pending and ambiguous pairing',()=>{
 const success=classifyToolFileOperations(confirmed(write('ok.txt')))[0];assert.equal(success.state,'succeeded');assert.equal(success.operations[0].path,'ok.txt');
 const failed=classifyToolFileOperations(write('failed.txt')+'\n'+RES('ERROR'))[0];assert.equal(failed.state,'failed');assert.deepEqual(failed.operations,[]);assert.equal(failed.candidates[0].path,'failed.txt');
 assert.equal(classifyToolFileOperations(write('pending.txt'))[0].state,'pending');
 const ambiguous=classifyToolFileOperations(write('failed.txt')+'\n'+RES('ERROR')+'\n'+write('pending.txt'));assert.deepEqual(ambiguous.map(call=>call.state),['unknown','unknown']);assert.deepEqual(extractFileChanges(write('failed.txt')+'\n'+RES('ERROR')),[]);
});


test('equal-count concurrent calls without IDs cannot attribute success to a requested path', () => {
    const text = [write('C:/failed.js'),write('C:/succeeded.js'),RES('SUCCESS'),RES('ERROR')].join('\n');
    assert.deepEqual(classifyToolFileOperations(text).map(call=>call.state),['unknown','unknown']);
    assert.deepEqual(extractFileChanges(text),[]);
});

test('results preceding a request do not confirm it; later sequential requests remain attributable', () => {
    assert.deepEqual(extractFileChanges([RES('SUCCESS'),write('C:/unconfirmed.js')].join('\n')),[]);
    const text=[write('C:/ambiguous1.js'),write('C:/ambiguous2.js'),RES('SUCCESS'),RES('ERROR'),write('C:/known.js'),RES('SUCCESS')].join('\n');
    assert.deepEqual(extractFileChanges(text),[{path:'C:/known.js',op:'write'}]);
});
