import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialize } from '../modules/ipc/sideChatHandlers.js';
import trustedFixture from './helpers/trusted-main-sender.cjs';

test('all side-chat IPCs deny remote, foreign window, subframe and guest senders before touching data', async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidechat-auth-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const trusted=trustedFixture.createTrustedMainSender();const handlers=new Map();
    initialize({USER_DATA_DIR:root,mainWindow:trusted.mainWindow,ipcMain:{handle:(c,h)=>handlers.set(c,h)}});
    const foreign=trustedFixture.createTrustedMainSender();
    const events=[{},foreign.event,{sender:trusted.sender,senderFrame:{url:trusted.sender.mainFrame.url}},
        {sender:trusted.sender,senderFrame:{url:'https://untrusted.invalid/main.html'}}];
    for(const event of events) for(const [channel,handler]of handlers)
        assert.deepEqual(await handler(event,'agent','topic','child'),{success:false,error:'UNAUTHORIZED_SENDER'},channel);
    const original=trusted.sender.getType;trusted.sender.getType=()=> 'webview';
    assert.equal((await handlers.get('side-chat:create-child')(trusted.event,'agent')).error,'UNAUTHORIZED_SENDER');
    trusted.sender.getType=original;
    assert.deepEqual(await fs.readdir(root),[],'denied requests did not create directories');
    assert.equal((await handlers.get('side-chat:create-child')(trusted.event,'agent')).success,true);
});

test('side-chat metadata and snapshots cannot alter a real topic or rebind a child to another parent', async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidechat-boundary-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const trusted=trustedFixture.createTrustedMainSender();const handlers=new Map();
    initialize({USER_DATA_DIR:root,mainWindow:trusted.mainWindow,ipcMain:{handle:(c,h)=>handlers.set(c,h)}});
    const call=(c,...args)=>handlers.get(c)(trusted.event,...args);
    const real=path.join(root,'agent/topics/real');await fs.mkdir(real,{recursive:true});await fs.writeFile(path.join(real,'history.json'),'[]');
    const meta=topicId=>({parent:{itemId:'agent',topicId:'parent'},child:{itemId:'agent',topicId},title:'memo'});
    for(const c of ['side-chat:save-metadata','side-chat:create-snapshot','side-chat:delete-child']) {
        const args=c.endsWith('save-metadata')?[meta('real')]:c.endsWith('create-snapshot')?['agent','parent','real']:['agent','real'];
        assert.equal((await call(c,...args)).success,false,c);
    }
    assert.deepEqual(await fs.readdir(real),['history.json']);
    const child=await call('side-chat:create-child','agent');
    assert.equal((await call('side-chat:create-snapshot','agent','parent',child.topicId)).success,true);
    assert.equal((await call('side-chat:save-metadata',meta(child.topicId))).success,true);
    assert.equal((await call('side-chat:create-snapshot','agent','other-parent',child.topicId)).success,false);
    const other={...meta(child.topicId),parent:{itemId:'other-agent',topicId:'parent'}};
    assert.equal((await call('side-chat:save-metadata',other)).error,'INVALID_PARENT');
    const marker=path.join(root,'agent/topics',child.topicId,'sidechat-child.json');await fs.writeFile(marker,'{}');
    assert.equal((await call('side-chat:delete-child','agent',child.topicId)).success,false,'a filename alone is not a valid side-chat marker');
});

test('junction ancestors cannot redirect creation, reads or deletion into another directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidechat-junction-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const outside=path.join(root,'owned-other');await fs.mkdir(path.join(outside,'topics/child'),{recursive:true});
 await fs.writeFile(path.join(outside,'topics/child/sidechat-child.json'),JSON.stringify({schemaVersion:1,ephemeral:true,agentId:'agent',topicId:'child'}));
 await fs.symlink(outside,path.join(root,'agent'),process.platform==='win32'?'junction':'dir');
 const trusted=trustedFixture.createTrustedMainSender(),handlers=new Map();initialize({USER_DATA_DIR:root,mainWindow:trusted.mainWindow,ipcMain:{handle:(c,h)=>handlers.set(c,h)}});
 const call=(c,...a)=>handlers.get(c)(trusted.event,...a);
 assert.equal((await call('side-chat:create-child','agent')).success,false);
 assert.equal((await call('side-chat:delete-child','agent','child')).success,false);
 assert.deepEqual((await call('side-chat:list-metadata','agent')).items,[]);
 assert.ok((await fs.stat(path.join(outside,'topics/child'))).isDirectory());
});
