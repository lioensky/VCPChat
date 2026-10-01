import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConversationScope, normalizeCommand, scopeSignature } from '../modules/ui-system/conversation-scope.js';

// 请求 / 结果格式取自真实聊天记录里的 ProjectForge 与 PowerShellExecutor 调用（内容做了删减）。
const REQ = (body) => `<<<[TOOL_REQUEST]>>>\n${body}\n<<<[END_TOOL_REQUEST]>>>`;
const RESULT = (tool, body) => `<<<[ROLE_DIVIDE_USER]>>>\n\n[[VCP调用结果信息汇总:\n- 工具名称: ${tool}\n- 执行状态: ✅ SUCCESS\n- 返回内容: ${body}\nVCP调用结果结束]]\n\n<<<[END_ROLE_DIVIDE_USER]>>>`;
const forge = (fields) => REQ(`maid:「始」Nova「末」,\ntool_name:「始」ProjectForge「末」,\n${fields}`);
const ps = (command) => REQ(`tool_name:「始」PowerShellExecutor「末」,\ncommand:「始」${command}「末」,\nexecutionType:「始」blocking「末」`);

const createProject = [
    forge('command:「始」CreateProject「末」,\nworkspace:「始」uva「末」,\nname:「始」UvA算法考点工程「末」'),
    RESULT('ProjectForge', '## ✅ 工程已创建：UvA算法考点工程\n- projectId：`pqug7`（后续所有施工命令只需传这个 ID）\n- 根目录：C:\Users\CHENXI\Documents\UvA（工作区 `uva`）')
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
