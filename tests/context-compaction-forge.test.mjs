import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectForgeHistory, recoverForgeSource, renderForgeStages } from '../modules/chat/contextCompactionForge.js';

export const request = (command, fields = {}, projectId = 'p1') => '<<<[TOOL_REQUEST]>>>\n' + Object.entries({tool_name:'ProjectForge',command,projectId,...fields}).map(([key,value]) => `${key}:「始」${value}「末」`).join(',\n') + '\n<<<[END_TOOL_REQUEST]>>>';
export const result = (body, status = '✅ SUCCESS') => `[[VCP调用结果信息汇总:\n- 工具名称: ProjectForge\n- 执行状态: ${status}\n- 返回内容: ${body}\nVCP调用结果结束]]`;
const batch = (text, id) => `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n${text}\n<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
export const exchange = (command, fields, body, id, options = {}) => request(command, fields, options.projectId || 'p1') + '\n<<<[ROLE_DIVIDE_USER]>>>\n' + (options.legacy ? result(body, options.status) : batch(result(body, options.status), id)) + '\n<<<[END_ROLE_DIVIDE_USER]>>>\n';
export const bigRead = '## ReadCode · src/a.js\n' + Array.from({length:1800}, (_,index) => `${index+1} | const value${index} = ${index};`).join('\n');
export const closeBody = (projectId = 'p1', changes = '#1→done') => `## Todo 已更新 · demo（\`${projectId}\`）\n- 变更：${changes}\n### Todo\n- [x] #1 实现`;
export function engineeringHistory(options = {}) {
    const projectId = options.projectId || 'p1';
    return [
        {id:'u',role:'user',content:'只改 src/a.js，不要重启。'},
        {id:'a',role:'assistant',timestamp:100,content:'先读取。\n'+exchange('ReadCode',{path:'src/a.js',reason:'核对实现'},bigRead,'one',{...options,projectId})+'查明实现后继续。\n'+exchange('UpdateTodos',{done:'1'},closeBody(projectId),'close',{...options,projectId})+'阶段声明：只完成实现，未验运行态。'},
        {id:'tail1',role:'assistant',content:exchange('GetProject',{},'project snapshot','hot1',{projectId})},
        {id:'tail2',role:'assistant',content:exchange('GetProject',{},'project snapshot','hot2',{projectId})},
    ];
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze(value) { if(value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('modern and legacy: only closed Todo stages fold, preserving requests/narrative/hot tail and raw SHA', () => {
    for (const legacy of [false,true]) {
        const history = freeze(engineeringHistory({legacy}));
        const before = hash(history);
        const projected = projectForgeHistory(history);
        assert.equal(projected.stages.length,1);
        assert.equal(projected.stats.foldedResults,1);
        assert.ok(projected.stats.savedChars > 10000);
        assert.equal(projected.history[0],history[0]);
        assert.equal(projected.history[2],history[2]);
        assert.equal(projected.history[3],history[3]);
        assert.ok(projected.history[1].content.includes(request('ReadCode',{path:'src/a.js',reason:'核对实现'})));
        assert.match(projected.history[1].content,/查明实现后继续。/);
        assert.match(projected.history[1].content,/阶段声明：只完成实现，未验运行态。/);
        assert.equal(hash(history),before);
        for(const entry of projected.stages[0].entries) assert.equal(recoverForgeSource(history,entry.source), history[1].content.slice(entry.source.start,entry.source.end));
        const total = JSON.stringify(projected.history).length + JSON.stringify(projected.stages).length + JSON.stringify(renderForgeStages(projected.stages)).length;
        assert.ok(total < JSON.stringify(history).length);
        assert.deepEqual(projectForgeHistory(projected.history).history,projected.history);
    }
});

test('no done, doing-only, failed, wrong project, missing ids and conflicting status never close', () => {
    const original = engineeringHistory();
    const content = original[1].content;
    for(const changed of [
        content.slice(0,content.indexOf(request('UpdateTodos',{done:'1'}))),
        content.replace('done:「始」1「末」','doing:「始」1「末」'),
        content.replace(closeBody(),closeBody('other')),
        content.replace(closeBody(),closeBody('p1','#1→doing')),
        content.replace(closeBody(),closeBody()+'\n- ⚠️ 未找到的序号：2'),
        content.replace('done:「始」1「末」','done:「始」1「末」, doing:「始」1「末」'),
        content.replace('done:「始」1「末」','done:「始」1「末」, reason:「始」broken'),
        content.replace(result(closeBody()),result(closeBody(),'❌ ERROR')),
    ]) {
        const history = structuredClone(original); history[1].content = changed;
        assert.equal(projectForgeHistory(history).history,history);
    }
    const noId = structuredClone(original); delete noId[1].id;
    assert.equal(projectForgeHistory(noId).history,noId);
});

test('concurrent/malformed batch, nested markers, code examples, media and user-quoted traffic are barriers', () => {
    for(const mutate of [
        text => text.replace(batch(result(closeBody()),'close'),batch(result(closeBody())+result(closeBody()),'close')),
        text => text.replace('<<<[VCP_TOOL_BATCH_END:close]>>>',''),
        text => text.replace(bigRead,bigRead+'\n'+result(closeBody())),
        text => '```text\n'+text+'\n```',
        text => text.replace(bigRead,bigRead+'\n审批留言：不要动'),
    ]) {
        const history = engineeringHistory(); history[1].content = mutate(history[1].content);
        assert.equal(projectForgeHistory(history).history,history);
    }
    for(const patch of [{role:'user'},{isThinking:true},{attachments:[{type:'image/png'}]},{tool_calls:[{}]}]) {
        const history = engineeringHistory(); Object.assign(history[1],patch);
        assert.equal(projectForgeHistory(history).history,history);
    }
});

test('recent protection is not a second trigger; failure text and shell/unknown results are never shortened', () => {
    const history = engineeringHistory();
    assert.equal(projectForgeHistory(history,{keepRecentBatches:100}).history,history);
    history[1].content = history[1].content.replace(bigRead,bigRead+'\nError: deliberate failure\n[exit code: 1]');
    assert.equal(projectForgeHistory(history).history,history);
    const unknown = engineeringHistory(); unknown[1].content = unknown[1].content.replace('command:「始」ReadCode「末」','command:「始」Unknown「末」');
    assert.equal(projectForgeHistory(unknown).history,unknown);
});

test('source edits/deletes/duplicate ids invalidate readback, JSON roundtrip preserves it', () => {
    const history = engineeringHistory();
    const projected = projectForgeHistory(history);
    const source = JSON.parse(JSON.stringify(projected.stages[0].entries[0].source));
    assert.ok(recoverForgeSource(JSON.parse(JSON.stringify(history)),source));
    const edited = structuredClone(history); edited[1].content += 'changed';
    assert.equal(recoverForgeSource(edited,source),null);
    assert.equal(recoverForgeSource(history.filter(message=>message.id!=='a'),source),null);
    assert.equal(recoverForgeSource([...history,history[1]],source),null);
    assert.equal(projectForgeHistory([...history,history[1]]).history.length,history.length+1);
});

test('projects remain separate and array text parts are copied without changing user bytes', () => {
    const first = engineeringHistory();
    const second = engineeringHistory({projectId:'p2'}).map(message=>({...message,id:'second-'+message.id}));
    const history = [...first,...second];
    const projected = projectForgeHistory(history,{keepRecentBatches:0});
    assert.deepEqual(projected.stages.map(stage=>stage.projectId),['p1','p2']);
    const arrayHistory = engineeringHistory(); arrayHistory[1].content = [{type:'text',text:arrayHistory[1].content}];
    assert.equal(projectForgeHistory(arrayHistory).stats.foldedResults,1);
    const mixed = engineeringHistory(); mixed[1].content = [{type:'text',text:mixed[1].content},{type:'image_url',image_url:{url:'image'}}];
    assert.equal(projectForgeHistory(mixed).history,mixed);
});

test('real server batch summary epilogue allows folding; arbitrary or incomplete tails do not', () => {
    const history = engineeringHistory();
    const summary = '\n[本轮工具调用摘要:]\nProjectForge 调用成功 (记录ID: fixture-1)。\n[本轮工具调用摘要结束]\n';
    for (const message of history) if (message.role === 'assistant') {
        message.content = message.content.replace(/(<<<\[VCP_TOOL_BATCH_END:[^\]]+\]>>>)/g, summary + '$1');
    }
    const projected = projectForgeHistory(history);
    assert.equal(projected.stats.foldedResults, 1);
    assert.ok(projected.history[1].content.includes(summary));
    for (const suffix of ['arbitrary text', summary.replace('[本轮工具调用摘要结束]', ''), summary + 'extra']) {
        const broken = engineeringHistory();
        broken[1].content = broken[1].content.replace('<<<[VCP_TOOL_BATCH_END:one]>>>', suffix + '<<<[VCP_TOOL_BATCH_END:one]>>>');
        assert.equal(projectForgeHistory(broken).history, broken);
    }
});

test('non-owned serial calls are opaque barriers, not a veto on later complete stages', () => {
    for (const command of ['CreateProject', 'ListProjects', 'Unknown']) {
        const history = engineeringHistory();
        const opaque = exchange(command, { projectId: '', name: 'demo' }, 'unowned result', 'create');
        history[1].content = opaque + history[1].content;
        const projected = projectForgeHistory(history);
        assert.equal(projected.stats.foldedResults, 1, command);
        assert.ok(projected.history[1].content.startsWith(opaque));
        assert.ok(projected.stages[0].entries.every(entry => entry.command !== command));
    }
    const split = engineeringHistory();
    const barrier = exchange('CreateProject', { projectId: '' }, 'new project', 'barrier');
    split[1].content = split[1].content.replace('查明实现后继续。', barrier + '查明实现后继续。');
    assert.equal(projectForgeHistory(split).history, split, 'closure must not borrow reads before an ownership barrier');
});
