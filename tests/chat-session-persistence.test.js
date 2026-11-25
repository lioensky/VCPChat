'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Manager = require('../modules/utils/appSettingsManager');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vchat-session-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    return { file, backup: file + '.backup', session: path.join(dir,'session.json'), manager: new Manager(file) };
}
function switchTo(m, id) {
    const values = {lastOpenItemId:id, lastOpenItemType:'agent', lastOpenTopicId:`topic-${id}`};
    return m.updateSettings({__vcpSettingsOps:Object.entries(values).map(([key,value]) =>
        ({op:'set',path:[key],value}))}, {sessionOnly:true});
}
async function stamp(file) {
    return [(await fs.readFile(file)).toString('hex'), (await fs.stat(file,{bigint:true})).mtimeNs];
}

test('rapid switches preserve durable bytes, mtimes, revision and workspace events', async t => {
    const {file, backup, manager:m} = await fixture(t);
    const ws = Array.from({length:4}, (_,i)=>({id:`w${i}`,path:`/fixture/${i}`}));
    await fs.writeFile(file, JSON.stringify({workspaces:ws}));
    await fs.writeFile(backup, JSON.stringify({workspaces:ws.slice(0,3)}));
    const before = await Promise.all([stamp(file),stamp(backup)]);
    const revision = m.getRevision(await m.readSettings());
    let events=0;
    m.on('settings-updated',()=>events++);
    m.readForUpdate=()=>{throw Error('session operation reached durable reader');};
    const results = await Promise.all(['A','B','C','A','B'].map(id=>switchTo(m,id)));
    assert.ok(results.every(r=>r.success && r.sessionOnly));
    assert.deepEqual(await Promise.all([stamp(file),stamp(backup)]),before);
    assert.equal(events,0);
    for(const reader of [m,new Manager(file)]) {
        const state=await reader.readSettings();
        assert.equal(state.lastOpenTopicId,'topic-B');
        assert.deepEqual(state.workspaces,ws);
        assert.equal(reader.getRevision(state),revision);
    }
});

test('session-only first run does not create settings or promote backup', async t => {
    const {file,backup,manager:m}=await fixture(t);
    await switchTo(m,'A');
    assert.equal((await new Manager(file).readSettings()).lastOpenItemId,'A');
    await fs.writeFile(backup,'{"workspaces":[]}');
    const before=await stamp(backup);
    await switchTo(m,'B');
    await assert.rejects(fs.access(file),{code:'ENOENT'});
    assert.deepEqual(await stamp(backup),before);
});

test('bad session or invalid operation fails without blocking next switch', async t => {
    const {session,manager:m}=await fixture(t);
    await fs.writeFile(session,'{broken');
    await assert.rejects(switchTo(m,'A'),SyntaxError);
    assert.equal(await fs.readFile(session,'utf8'),'{broken');
    await fs.unlink(session);
    await assert.rejects(m.updateSettings({__vcpSettingsOps:[{op:'set',path:['workspaces'],value:null}]},
        {sessionOnly:true}),/Invalid session-only operation/);
    assert.equal((await switchTo(m,'B')).success,true);
});