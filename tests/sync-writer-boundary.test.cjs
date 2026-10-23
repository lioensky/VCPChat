'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createSyncWriterBoundary}=require('../modules/services/syncWriterBoundary');
const root=path.join(require('node:os').tmpdir(),'native-sync-boundary');
const queue={userDataDir:root,syncPolicy:{topics:[{itemId:'AgentA',itemType:'agent',topicId:'shared'}]},getHistoryPath:(a,t)=>path.resolve(root,a,'topics',t,'history.json')};
test('physical shared history and containing owner are excluded regardless of claimed Owner type',()=>{
 const boundary=createSyncWriterBoundary(queue);
 for(const ownerType of ['agent','group']) {
  assert.throws(()=>boundary.assertWrite({ownerType,ownerId:'AgentA',topicId:'shared'}),e=>e.code==='SYNC_WRITER_EXCLUDED'&&e.retryable===false);
  assert.throws(()=>boundary.assertWrite({ownerType,ownerId:'AgentA'}),e=>e.code==='SYNC_WRITER_EXCLUDED');
 }
 if(process.platform==='win32')assert.throws(()=>boundary.assertWrite({ownerType:'agent',ownerId:'agenta',topicId:'SHARED'}),e=>e.code==='SYNC_WRITER_EXCLUDED');
});
test('nonshared topics/owners and NativeSync-off behavior remain available; boundary follows current policy',()=>{
 const boundary=createSyncWriterBoundary(queue);
 assert.doesNotThrow(()=>boundary.assertWrite({ownerType:'agent',ownerId:'AgentA',topicId:'other'}));
 assert.doesNotThrow(()=>boundary.assertWrite({ownerType:'agent',ownerId:'AgentB'}));
 assert.equal(boundary.active(),true);
 assert.doesNotThrow(()=>createSyncWriterBoundary(null).assertWrite({ownerType:'agent',ownerId:'AgentA'}));
 const other={...queue,syncPolicy:null};assert.equal(createSyncWriterBoundary(other).active(),false);
 assert.doesNotThrow(()=>createSyncWriterBoundary(other).assertWrite({ownerType:'agent',ownerId:'AgentA',topicId:'shared'}));
});
test('Legacy activation with active NativeSync fails before opening either plugin database or listeners',async()=>{
 const plugin=require('../VCPDistributedServer/Plugin/VCPMobileSync');
 await assert.rejects(plugin.registerRoutes({}, {MobileSyncToken:'synthetic-unit-only',MobileSyncUseCentralIndex:false},path.resolve(__dirname,'../VCPDistributedServer'),{historyMutationQueue:queue}),e=>e.code==='SYNC_WRITER_EXCLUDED');
});
test('physical directory aliases cannot enter a second MobileSync writer while NativeSync is active',()=>{
 const fs=require('node:fs');fs.mkdirSync(root,{recursive:true});const temp=fs.mkdtempSync(path.join(root,'alias-'));
 const real=path.join(temp,'real');fs.mkdirSync(real);const alias=path.join(temp,'alias');fs.symlinkSync(real,alias,process.platform==='win32'?'junction':'dir');
 const q={...queue,userDataDir:temp,getHistoryPath:(a,t)=>path.resolve(temp,a,'topics',t,'history.json')};
 assert.throws(()=>createSyncWriterBoundary(q).assertWrite({ownerType:'agent',ownerId:'alias',topicId:'any'}),e=>e.code==='SYNC_WRITER_EXCLUDED');
});
