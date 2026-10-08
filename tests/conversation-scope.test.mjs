import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConversationScope, normalizeCommand, scopeSignature, readRevertBatches, recordRevertBatch } from '../modules/ui-system/conversation-scope.js';
import { pickTopicProject } from '../modules/ui-system/project-plan-model.js';

// 请求 / 结果格式取自真实聊天记录里的 ProjectForge 与 PowerShellExecutor 调用（内容做了删减）。
const REQ = (body) => `<<<[TOOL_REQUEST]>>>\n${body}\n<<<[END_TOOL_REQUEST]>>>`;
const RESULT = (tool, body) => `<<<[ROLE_DIVIDE_USER]>>>\n\n[[VCP调用结果信息汇总:\n- 工具名称: ${tool}\n- 执行状态: ✅ SUCCESS\n- 返回内容: ${body}\nVCP调用结果结束]]\n\n<<<[END_ROLE_DIVIDE_USER]>>>`;
const forge = (fields) => REQ(`maid:「始」Nova「末」,\ntool_name:「始」ProjectForge「末」,\n${fields}`);
const ps = (command) => REQ(`tool_name:「始」PowerShellExecutor「末」,\ncommand:「始」${command}「末」,\nexecutionType:「始」blocking「末」`);

const createProject = [
    forge('command:「始」CreateProject「末」,\nworkspace:「始」demo「末」,\nname:「始」算法演示工程「末」'),
    RESULT('ProjectForge', '## ✅ 工程已创建：算法演示工程\n- projectId：`pqug7`（后续所有施工命令只需传这个 ID）\n- 根目录：C:\Projects\algorithms-demo（工作区 `demo`）')
].join('\n');

test('a conversation that never touched ProjectForge or the terminal has an empty scope', () => {
    const scope = collectConversationScope([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，我是 Nova。' }
    ]);
    assert.deepEqual(scope.projectIds, []);
    assert.equal(scope.commands.size, 0);
    assert.deepEqual(collectConversationScope(null).projectIds, []);
});

test('project ids come from CreateProject results and later requests, most recently mentioned first', () => {
    const history = [
        { role: 'assistant', content: createProject },
        { role: 'assistant', content: forge('command:「始」CreateFile「末」,\nprojectId:「始」pqug7「末」,\npath:「始」a.py「末」') },
        { role: 'assistant', content: forge('command:「始」GetProject「末」,\nprojectId:「始」zz99a「末」') },
        { role: 'assistant', content: forge('command:「始」EditCode「末」,\nprojectId:「始」pqug7「末」,\npath:「始」a.py「末」') }
    ];
    assert.deepEqual(collectConversationScope(history).projectIds, ['pqug7', 'zz99a']);
});

test('inside one message the project mentioned last wins, even when an older one shows up in an earlier result', () => {
    // 真实场景：一条回答里先 GetProject 旧工程（结果带根目录），后面再 CreateProject / 操作新工程
    const getOld = [
        forge('command:「始」GetProject「末」,\nprojectId:「始」pold1「末」'),
        RESULT('ProjectForge', '## 工程概况\n- 工程：旧工程（`pold1`）· 进行中\n- 根目录：D:\\old')
    ].join('\n');
    const createNew = [
        forge('command:「始」CreateProject「末」,\nworkspace:「始」w「末」,\nname:「始」新工程「末」'),
        RESULT('ProjectForge', '## ✅ 工程已创建：新工程\n- projectId：`pnew2`\n- 根目录：D:\\new')
    ].join('\n');
    const history = [{ role: 'assistant', content: [getOld, createNew, forge('command:「始」UpdatePlan「末」,\nprojectId:「始」pnew2「末」')].join('\n') }];
    assert.deepEqual(collectConversationScope(history).projectIds, ['pnew2', 'pold1']);
    // 结果里的根目录不能压过后面的请求：先建 pnew2、再看一眼 pold1、最后继续改 pnew2
    const back = [createNew, getOld, forge('command:「始」UpdatePlan「末」,\nprojectId:「始」pnew2「末」')].join('\n');
    assert.deepEqual(collectConversationScope([{ role: 'assistant', content: back }]).projectIds, ['pnew2', 'pold1']);
});

test('PowerShellExecutor commands preserve shell whitespace, other tools are ignored', () => {
    const history = [
        { role: 'assistant', content: ps('Get-ChildItem -Path "../../Plugin"   -Recurse') },
        { role: 'assistant', content: REQ('tool_name:「始」FileOperator「末」,\ncommand:「始」WriteFile「末」,\nfilePath:「始」C:/a.js「末」') },
        { role: 'assistant', content: REQ('tool_name:「始」PowerShellExecutor「末」,\ncommand1:「始」git status「末」,\ncommand2:「始」git  log -1「末」') }
    ];
    const { commands } = collectConversationScope(history);
    assert.deepEqual([...commands].sort(), ['Get-ChildItem -Path "../../Plugin"   -Recurse', 'git  log -1', 'git status']);
    assert.equal(normalizeCommand('  a \n  b\t c '), 'a \n  b\t c');
});

test('messages with array content are read too, and the signature changes only when the scope does', () => {
    const history = [{ role: 'assistant', content: [{ type: 'text', text: ps('git status') }] }];
    const scope = collectConversationScope(history);
    assert.equal(scope.commands.has('git status'), true);
    const same = collectConversationScope([...history, { role: 'user', content: '谢谢' }]);
    assert.equal(scopeSignature(same), scopeSignature(scope));
    const more = collectConversationScope([...history, { role: 'assistant', content: createProject }]);
    assert.notEqual(scopeSignature(more), scopeSignature(scope));
});

test('quoted whitespace and equal-size command sets have different identities',()=>{
assert.notEqual(normalizeCommand('echo "a  b"'),normalizeCommand('echo "a b"'));
assert.notEqual(scopeSignature({projectIds:[],commands:new Set(['a'])}),scopeSignature({projectIds:[],commands:new Set(['b'])}));
});

test('batch ids come from construction results, not from timeline or history listings', () => {
    const edit = [
        forge('command:「始」EditCode「末」,\nprojectId:「始」pzi2e「末」,\npath:「始」a.py「末」'),
        RESULT('ProjectForge', '## ✅ EditCode · `a.py`\n- 节点 `n11` · 批次 `b11` · 工程 `pzi2e` · @Nova')
    ].join('\n');
    const rollback = RESULT('ProjectForge', '## ✅ Rollback\n- 回退批次 `b14`（回退本身也可再回退：Rollback batch=b14）');
    const timeline = RESULT('ProjectForge', '## 开发脉络\n- `b3` · 编辑 · @Nova · 10:00 · 初版\n  - a.py (+3/-0)\n- `n2` · `b2` · @Nova · edit · `a.py`');
    const scope = collectConversationScope([
        { role: 'assistant', content: edit },
        { role: 'assistant', content: rollback },
        { role: 'assistant', content: timeline }
    ]);
    assert.deepEqual([...scope.batchIds].sort((a, b) => a - b), [11, 14]);
    const without = collectConversationScope([{ role: 'assistant', content: edit }]);
    assert.notEqual(scopeSignature(without), scopeSignature(scope));
});

test('reverts made from the side pane are remembered per topic', () => {
    const data = new Map();
    const storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
    recordRevertBatch(storage, 'agent:a:t1', 20);
    recordRevertBatch(storage, 'agent:a:t1', 21);
    recordRevertBatch(storage, 'agent:a:t1', 20);
    recordRevertBatch(storage, 'agent:a:t2', 30);
    assert.deepEqual(readRevertBatches(storage, 'agent:a:t1'), [21, 20]);
    assert.deepEqual(readRevertBatches(storage, 'agent:a:t2'), [30]);
    assert.deepEqual(readRevertBatches(storage, ''), []);
    assert.deepEqual(readRevertBatches({ getItem: () => '{bad' }, 'x'), []);
});

test('status panel and side pane pick the same project: most recent with a plan, else the most recent', () => {
    const a = { id: 'a', progress: { total: 0 } };
    const b = { id: 'b', progress: { total: 3 } };
    const c = { id: 'c', progress: { total: 1 } };
    assert.equal(pickTopicProject([a, b, c]).id, 'b');
    assert.equal(pickTopicProject([a, { id: 'd' }]).id, 'a');
    assert.equal(pickTopicProject([]), null);
});

