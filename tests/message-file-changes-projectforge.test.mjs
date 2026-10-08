import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractFileChanges, findProjectRoots, createMessageFileChanges } from '../modules/ui-system/message-file-changes.js';

// 请求 / 结果样例取自真实聊天记录里 ProjectForge 与 FileOperator 的输出（内容做了删减）。
// 注意真实的「执行状态」是「✅ SUCCESS」/「❌ ERROR」，而不是裸的 success。

const REQ = (body) => `<<<[TOOL_REQUEST]>>>\n${body}\n<<<[END_TOOL_REQUEST]>>>`;
const RESULT = (tool, status, body) => `<<<[ROLE_DIVIDE_USER]>>>\n\n[[VCP调用结果信息汇总:\n- 工具名称: ${tool}\n- 执行状态: ${status}\n- 返回内容: ${body}\nVCP调用结果结束]]\n\n<<<[END_ROLE_DIVIDE_USER]>>>`;
const forge = (fields) => REQ(`maid:「始」Nova「末」,\ntool_name:「始」ProjectForge「末」,\n${fields}`);
const OK = '✅ SUCCESS';
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

const PROJECT_ROOT = 'C:\\Projects\\algorithms-demo';
const createProjectCall = [
    forge('command:「始」CreateProject「末」,\nworkspace:「始」demo「末」,\nname:「始」算法演示工程「末」'),
    RESULT('ProjectForge', OK, [
        '## ✅ 工程已创建：算法演示工程',
        '- projectId：`pqug7`（后续所有施工命令只需传这个 ID）',
        '- 创建者：@Nova',
        `- 根目录：${PROJECT_ROOT}（工作区 \`demo\`）`,
        '- 文件路径请相对根目录书写，例如 `src/index.js`'
    ].join('\n'))
].join('\n');
const createFileCall = (path, lines) => [
    forge(`command:「始」CreateFile「末」,\nprojectId:「始」pqug7「末」,\npath:「始」${path}「末」,\ncontent:「始ESCAPE」print(1)「末ESCAPE」`),
    RESULT('ProjectForge', OK, `## ✅ 已新建 · \`${path}\`（${lines} 行，894 Bytes）\n- 节点 \`n1\` · 批次 \`b1\` · reason：创建\n### 代码审查\n- ✅ 未引入新问题`)
].join('\n');
const editCodeCall = (path, added, removed) => [
    forge(`command:「始」EditCode「末」,\nprojectId:「始」pqug7「末」,\npath:「始」${path}「末」,\ntarget:「始」a「末」,\nreplace:「始」b「末」`),
    RESULT('ProjectForge', OK, `## ✅ 已写入 · \`${path}\`\n- 节点 \`n2\` · 批次 \`b2\` · 工程 \`pqug7\` · @Nova\n### Diff (+${added} -${removed})\n\`\`\`diff\n--- a/${path}\n+++ b/${path}\n\`\`\``)
].join('\n');
const fileOperatorWrite = (path) => REQ(`tool_name:「始」FileOperator「末」,\ncommand:「始」WriteFile「末」,\nfilePath:「始」${path}「末」,\ncontent:「始」x「末」`);

test('the real "✅ SUCCESS" status keeps FileOperator calls and "❌ ERROR" drops them', () => {
    const text = [
        fileOperatorWrite('C:/ok.js'), RESULT('FileOperator', OK, 'done'),
        fileOperatorWrite('C:/bad.js'), RESULT('FileOperator', '❌ ERROR', '执行错误: {}')
    ].join('\n');
    assert.deepEqual(extractFileChanges(text), [{ path: 'C:/ok.js', op: 'write' }]);
});

test('ProjectForge: a file created and then edited is one new file whose stats are the final line count', () => {
    const text = [createProjectCall, createFileCall('exam_algorithms.py', 34), editCodeCall('exam_algorithms.py', 22, 10), editCodeCall('exam_algorithms.py', 27, 0)].join('\n');
    assert.deepEqual(extractFileChanges(text), [
        { path: 'exam_algorithms.py', projectId: 'pqug7', op: 'create', added: 73, removed: 0 }
    ]);
});

test('ProjectForge: edits of an existing file add up their +/- and keep the edit label', () => {
    const text = [editCodeCall('src/a.py', 22, 10), editCodeCall('src/a.py', 3, 1), editCodeCall('src/b.py', 1, 0)].join('\n');
    assert.deepEqual(extractFileChanges(text), [
        { path: 'src/a.py', projectId: 'pqug7', op: 'edit', added: 25, removed: 11 },
        { path: 'src/b.py', projectId: 'pqug7', op: 'edit', added: 1, removed: 0 }
    ]);
});

test('ProjectForge: "未写入" / "内容无变化" results are reported as SUCCESS by the plugin host but are not changes', () => {
    const rejected = [
        forge('command:「始」EditCode「末」,\nprojectId:「始」pqug7「末」,\npath:「始」a.py「末」,\ntarget:「始」x「末」,\nreplace:「始」y「末」'),
        RESULT('ProjectForge', OK, '## ❌ EditCode 未写入 · `a.py`\n### 错误\n- 步骤1：target 未找到')
    ].join('\n');
    const unchanged = [
        forge('command:「始」EditCode「末」,\nprojectId:「始」pqug7「末」,\npath:「始」b.py「末」,\ntarget:「始」x「末」,\nreplace:「始」x「末」'),
        RESULT('ProjectForge', OK, '## ℹ️ 内容无变化，未写入 · `b.py`')
    ].join('\n');
    assert.deepEqual(extractFileChanges([rejected, unchanged].join('\n')), []);
    assert.deepEqual(extractFileChanges([rejected, editCodeCall('c.py', 2, 1)].join('\n')).map(change => change.path), ['c.py']);
});

test('ProjectForge: RemoveFile, MoveFile and MoveCode are read from their results', () => {
    const remove = [
        forge('command:「始」RemoveFile「末」,\nprojectId:「始」pqug7「末」,\npaths:「始」old.py,gone.py「末」'),
        RESULT('ProjectForge', OK, '## ✅ RemoveFile · 批次 `b3`\n- reason：清理\n- 已移到系统回收站：`old.py`（节点 `n7`）\n- 失败：\n  - `gone.py`：文件不存在')
    ].join('\n');
    const move = [
        forge('command:「始」MoveFile「末」,\nprojectId:「始」pqug7「末」,\nfrom:「始」a.py「末」,\nto:「始」lib/a.py「末」'),
        RESULT('ProjectForge', OK, '## ✅ 已移动 · `a.py` → `lib/a.py`\n- 批次 `b4` · reason：整理')
    ].join('\n');
    const codeMove = [
        forge('command:「始」MoveCode「末」,\nprojectId:「始」pqug7「末」,\nfrom:「始」x.py:foo「末」,\ntarget:「始」y.py「末」'),
        RESULT('ProjectForge', OK, [
            '## ✅ 已剪切 · `x.py:foo` → `y.py`',
            '- 批次 `b5`',
            '### `x.py`',
            '### 代码审查',
            '- ✅ 未引入新问题',
            '### Diff (+0 -6)',
            '### `y.py`',
            '### Diff (+6 -0)'
        ].join('\n'))
    ].join('\n');
    assert.deepEqual(extractFileChanges([remove, move, codeMove].join('\n')), [
        { path: 'old.py', projectId: 'pqug7', op: 'delete' },
        { path: 'a.py', projectId: 'pqug7', op: 'move', to: 'lib/a.py' },
        { path: 'x.py', projectId: 'pqug7', op: 'edit', added: 0, removed: 6 },
        { path: 'y.py', projectId: 'pqug7', op: 'edit', added: 6, removed: 0 }
    ]);
});

test('ProjectForge: read-only commands are ignored; unconfirmed requests are not claimed as changes', () => {
    const readOnly = [
        forge('command:「始」ListWorkspaces「末」'),
        RESULT('ProjectForge', OK, '## 工作区\n- `demo`'),
        forge('command:「始」ReadCode「末」,\nprojectId:「始」pqug7「末」,\npath:「始」a.py「末」'),
        RESULT('ProjectForge', OK, '```python\nprint(1)\n```')
    ].join('\n');
    assert.deepEqual(extractFileChanges(readOnly), []);
    const cut = [
        forge('command:「始」CreateFile「末」,\nprojectId:「始」pqug7「末」,\npath:「始」a.py「末」,\ncontent:「始」x「末」'),
        forge('command:「始」EditCode「末」,\nprojectId:「始」pqug7「末」,\npath:「始」b.py「末」,\ntarget:「始」x「末」,\nreplace:「始」y「末」')
    ].join('\n');
    assert.deepEqual(extractFileChanges(cut), []);
});

test('findProjectRoots reads CreateProject and GetProject results; a later one replaces an earlier one', () => {
    const getProject = RESULT('ProjectForge', OK, '## 工程详情\n- 工程：算法演示工程（`pqug7`）· 状态 active\n- 根目录：D:\\moved\\demo（工作区 `demo`）');
    assert.equal(findProjectRoots([createProjectCall, null, '没有根目录的文本', getProject]).get('pqug7'), 'D:\\moved\\demo');
    assert.equal(findProjectRoots([createProjectCall]).get('pqug7'), PROJECT_ROOT);
    assert.equal(findProjectRoots([]).size, 0);
});

function mountMessage(messages, id) {
    const dom = new JSDOM('<div id="chatMessages"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    const calls = { opened: [], gitLookups: [], diffs: [] };
    const controller = createMessageFileChanges({
        document: doc,
        messagesRoot: root,
        getHistory: () => messages,
        openFile: path => calls.opened.push(path),
        getDiffStats: async (path) => { calls.gitLookups.push(path); return null; },
        openDiff: path => calls.diffs.push(path)
    });
    controller.mount();
    const item = doc.createElement('div');
    item.className = 'message-item assistant';
    item.dataset.messageId = id;
    item.innerHTML = '<div class="details-and-bubble-wrapper"><div class="md-content">x</div></div>';
    root.appendChild(item);
    return { root, controller, window: dom.window, ...calls };
}

test('ProjectForge rows show exact counts at once and open the file through the project root created in an earlier message', async () => {
    const messages = [
        { id: 'm0', role: 'assistant', content: createProjectCall },
        { id: 'm1', role: 'assistant', content: [createFileCall('src/exam.py', 34), editCodeCall('src/exam.py', 22, 10)].join('\n') }
    ];
    const { root, controller, window, opened, gitLookups, diffs } = mountMessage(messages, 'm1');
    await wait();
    const panel = root.querySelector('.vcp-file-changes');
    assert.ok(panel);
    const row = panel.querySelector('li');
    assert.equal(row.querySelector('.vcp-file-changes-op').textContent, '新建');
    assert.equal(row.querySelector('.text-diff-added').textContent, '+46');
    assert.equal(row.querySelector('.text-diff-removed').textContent, '-0');
    row.querySelector('button.vcp-file-changes-path').click();
    assert.deepEqual(opened, [`${PROJECT_ROOT}\\src\\exam.py`]);
    row.querySelector('.vcp-file-changes-counts').click();
    assert.deepEqual(diffs, opened);
    panel.open = true;
    panel.dispatchEvent(new window.Event('toggle'));
    await wait();
    assert.deepEqual(gitLookups, [], 'exact counts never go to Git');
    controller.dispose();
});

test('ProjectForge rows whose project root is unknown still list the file but cannot be opened', async () => {
    const { root, controller } = mountMessage([{ id: 'm1', role: 'assistant', content: editCodeCall('src/exam.py', 2, 1) }], 'm1');
    await wait();
    const row = root.querySelector('.vcp-file-changes li');
    assert.equal(row.querySelector('.vcp-file-changes-path').textContent, 'exam.py');
    assert.equal(row.querySelector('button.vcp-file-changes-path'), null);
    assert.equal(row.querySelector('.text-diff-added').textContent, '+2');
    controller.dispose();
});

test('ProjectForge: Rollback lists the files it restored, recreated or trashed', () => {
    const rollback = [
        forge('command:「始」Rollback「末」,\nprojectId:「始」pqug7「末」,\nbatch:「始」b38「末」'),
        RESULT('ProjectForge', OK, [
            '## ✅ 已回退：回退批次 b38（验证回退）',
            '- 回退批次 `b39`（回退本身也可再回退：Rollback batch=b39）',
            '- `tests/a.test.js`：恢复内容（节点 `n39`）',
            '- `src/new.js`：移到回收站（节点 `n40`）',
            '- `src/old.js`：重建文件（节点 `n41`）'
        ].join('\n'))
    ].join('\n');
    assert.deepEqual(extractFileChanges(rollback), [
        { path: 'tests/a.test.js', projectId: 'pqug7', op: 'edit' },
        { path: 'src/new.js', projectId: 'pqug7', op: 'delete' },
        { path: 'src/old.js', projectId: 'pqug7', op: 'create' }
    ]);

    // 预演和有冲突未执行的回退都不算改动
    const dryRun = [
        forge('command:「始」Rollback「末」,\nprojectId:「始」pqug7「末」,\nbatch:「始」last「末」,\ndryRun:「始」true「末」'),
        RESULT('ProjectForge', OK, '## 🔍 回退预演（dryRun）：回退批次 b38\n| 文件 | 动作 | 冲突 |\n|---|---|---|\n| `tests/a.test.js` | 恢复内容 | - |')
    ].join('\n');
    assert.deepEqual(extractFileChanges(dryRun), []);
});
