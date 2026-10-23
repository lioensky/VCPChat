'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {initialImport}=require('../modules/services/nativeSync/initialImport');
const {catalog}=require('../modules/services/nativeSync/catalog');
const {messageHash,tombstoneHash}=require('../modules/services/nativeSync/protocol');
const topic={itemId:'actual-id',itemType:'agent',topicId:'old-topic'},wire={ownerId:topic.itemId,ownerType:'agent',topicId:topic.topicId};
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'vcp-r10-desktop-'));const dir=path.join(root,'.native-sync');await fs.mkdir(dir);const history=[{id:'old-id',role:'user',content:'synthetic original content',timestamp:10}];const historyFile=path.join(root,'UserData',topic.itemId,'topics',topic.topicId,'history.json');await fs.mkdir(path.dirname(historyFile),{recursive:true});const bytes=JSON.stringify(history);await fs.writeFile(historyFile,bytes);const config={version:1,enabled:true,historySelectionApproved:true,deviceId:'existing-desktop',topics:[topic],serverUrl:'https://sync.example.invalid',credentialSource:'existing-vcp-settings',approvedHistory:[{...topic,rawFileSha256:crypto.createHash('sha256').update(bytes).digest('hex')}]};return {root,config,history,historyFile,write:()=>fs.writeFile(path.join(dir,'connection.json'),JSON.stringify(config)),queue:{userDataDir:path.join(root,'UserData'),getHistoryPath:()=>historyFile}};}
const settings=async()=>({vcpServerUrl:'https://sync.example.invalid/v1/chat/completions',vcpApiKey:'synthetic-existing-desktop-key'});
test('first import identifies identical history without mutating source or central state',async()=>{
 const f=await fixture(),before=await fs.readFile(f.historyFile);let requests=0;
 const proof=await initialImport({queue:f.queue,appDataRoot:f.root,connection:f.config,request:async route=>{requests++;assert.match(route,/^\/api\/v1\/sync\/pull\?/);return {events:[{...wire,msgId:'old-id',seq:1,action:'upsert',message:f.history[0],hash:messageHash(f.history[0])}],headSeq:1,nextSeq:1,hasMore:false};}});
 assert.equal(requests,1);assert.equal(proof.identicalRemoteMessages,1);assert.equal(proof.newLocalMessages,0);assert.equal(proof.centralWritten,false);assert.deepEqual(await fs.readFile(f.historyFile),before);assert.deepEqual(await fs.readdir(path.join(f.root,'.native-sync')),[]);
});
test('first import follows nextSeq across an empty authorized page without changing the approved source',async()=>{
 const f=await fixture(),before=await fs.readFile(f.historyFile);let calls=0;
 const proof=await initialImport({queue:f.queue,appDataRoot:f.root,connection:f.config,request:async route=>{
  calls++;if(calls===1)return {events:[],headSeq:501,nextSeq:500,hasMore:true};
  assert.match(route,/after_seq=500&/);return {events:[{...wire,msgId:'old-id',seq:501,action:'upsert',message:f.history[0],hash:messageHash(f.history[0])}],headSeq:501,nextSeq:501,hasMore:false};
 }});assert.equal(calls,2);assert.equal(proof.identicalRemoteMessages,1);assert.deepEqual(await fs.readFile(f.historyFile),before);
});
test('first import refuses changed approved files before any network, and refuses remote conflicts/tombstones/other owners',async()=>{
 const f=await fixture();await fs.appendFile(f.historyFile,' ');await assert.rejects(initialImport({queue:f.queue,appDataRoot:f.root,connection:f.config,request:()=>assert.fail('network before source approval check')}),e=>e.code==='APPROVED_HISTORY_CHANGED');await fs.writeFile(f.historyFile,JSON.stringify(f.history));
 for(const variant of ['conflict','deleted','other']){
  const event={...wire,msgId:'old-id',seq:1,action:'upsert',message:{...f.history[0],content:variant},hash:null};event.hash=messageHash(event.message);
  if(variant==='deleted'){event.action='delete';event.hash=tombstoneHash(event);delete event.message;}
  if(variant==='other')event.ownerId='unselected-owner';
  await assert.rejects(initialImport({queue:f.queue,appDataRoot:f.root,connection:f.config,request:async()=>({events:[event],headSeq:1,nextSeq:1,hasMore:false})}),e=>['INITIAL_IMPORT_CONTENT_CONFLICT','INITIAL_IMPORT_REMOTE_TOMBSTONE','CENTRAL_CONTAINS_UNSELECTED_TOPICS'].includes(e.code));
 }
});
test('catalog projection retains old IDs and exposes no Agent prompt, provider configuration or filesystem path',async()=>{
 const f=await fixture();const result=await catalog({appDataRoot:f.root,topics:[topic],readAgentConfig:async()=>({name:'Existing Agent',topics:[{id:topic.topicId,name:'Existing history'}],systemPrompt:'PRIVATE_PROMPT_MARKER',apiKey:'PRIVATE_KEY_MARKER',providerUrl:'PRIVATE_PROVIDER_MARKER'})});
 assert.equal(result.topics[0].ownerId,topic.itemId);assert.equal(result.topics[0].topicId,topic.topicId);const text=JSON.stringify(result);for(const value of ['PRIVATE_PROMPT','PRIVATE_KEY','PRIVATE_PROVIDER',f.root])assert.equal(text.includes(value),false);
});
