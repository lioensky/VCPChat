'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {setTimeout: delay} = require('node:timers/promises');
const service = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const {resolveDefaultBinaryPath} = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-qb-'));
    const binary = process.env.PF_SERVICE_BINARY || resolveDefaultBinaryPath();
    t.after(async () => { try { await service.cleanup(); } finally { await fs.rm(root,{recursive:true,force:true}); } });
    await fs.access(binary);
    service.initialize({serviceBinaryPath:binary,indexerBinaryPath:binary,dbPath:path.join(root,'db.sqlite'),config:{BASH_ENABLED:false},workspaceService:{list:()=>[{id:'demo',alias:'demo',enabled:true,path:root}],getActiveWorkspaceId:()=>'demo'}});
    const create = async name => (await service.processToolCall({command:'CreateProject',name,dir:name})).details.project.id;
    const a = await create('a'); const b = await create('b');
    const call = (command,projectId,args={},ctx={})=>service.processToolCall({command,projectId,...args},ctx);
    return {root,a,b,call};
}
async function started(dir, job) {
    await Promise.race([job.then(()=>{throw Error('Bash exited before ready');}), (async()=>{
        for(let i=0;i<200;i++){try{await fs.access(path.join(dir,'ready'));return;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(20);}throw Error('Bash startup marker missing');
    })()]);
}
const trusted = {allowBash:true};

test('ProjectForge Query groups source slices from real Rust symbol hits',async t=>{
    const {root,a,call}=await fixture(t);
    for(const [dir,value] of [['left','LEFT'],['right','RIGHT'],['tests','IGNORE']]){
        const folder=path.join(root,'a',dir);await fs.mkdir(folder);await fs.writeFile(path.join(folder,'unit.js'),`function inspectUnit(x) { return '${value}' + x; }\n`);
    }
    const r=await call('Query',a,{code:`const hits=await q.symbols({name:'inspectUnit',exact:true});
        const rows=await Promise.all(hits.filter(h=>!h.path.startsWith('tests/')).map(async h=>({path:h.path,key:h.name,text:await q.read(h.path+'#'+h.name)})));
        return rows.reduce((groups,r)=>{(groups[r.key] ||= []).push(r.text.trim());return groups;},{});`});
    assert.deepEqual(r.details.value.inspectUnit.sort(),["function inspectUnit(x) { return 'LEFT' + x; }","function inspectUnit(x) { return 'RIGHT' + x; }"]);
});

test('Bash host authorization cannot be supplied by tool arguments; native exit survives routing',async t=>{
    const {root,a,call}=await fixture(t);
    await assert.rejects(call('Bash',a,{allowBash:true,executionContext:trusted,script:'touch unauthorized'}));
    await assert.rejects(fs.access(path.join(root,'a','unauthorized')),{code:'ENOENT'});
    const r=await call('Bash',a,{script:'exit 7'},trusted);
    assert.equal(r.details.status,'exited');assert.equal(r.details.exitCode,7);
});

test('same-project write waits while another project can query during Bash',async t=>{
    const {root,a,b,call}=await fixture(t);const dir=path.join(root,'a');
    const job=call('Bash',a,{script:'touch ready; while [ ! -f release ]; do sleep 0.05; done; test ! -e managed.txt',timeoutMs:10000},trusted);
    await started(dir,job);
    const write=call('CreateFile',a,{path:'managed.txt',content:'managed',reason:'integration fixture'}); write.catch(()=>{});
    try { const r=await call('Query',b,{code:'return 42'});assert.equal(r.details.value,42);await assert.rejects(fs.access(path.join(dir,'managed.txt')),{code:'ENOENT'}); }
    finally {await fs.writeFile(path.join(dir,'release'),'');await Promise.allSettled([job,write]);}
    assert.equal((await job).details.exitCode,0);await write;assert.equal(await fs.readFile(path.join(dir,'managed.txt'),'utf8'),'managed');
});

test('cleanup interrupts admitted Bash rather than waiting for command timeout',async t=>{
    const {root,a,call}=await fixture(t);const dir=path.join(root,'a');
    const job=call('Bash',a,{script:'touch ready; sleep 7; touch completed',timeoutMs:12000},trusted);
    const result=Promise.allSettled([job]);await started(dir,job);await service.cleanup();
    const [outcome]=await result;if(outcome.status==='fulfilled')assert.notEqual(outcome.value.details.status,'exited');
    await assert.rejects(fs.access(path.join(dir,'completed')),{code:'ENOENT'});
});
