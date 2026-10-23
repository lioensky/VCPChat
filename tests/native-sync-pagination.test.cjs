'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const http=require('node:http');
const {CentralStore}=require('./helpers/nativeSyncCentralStore.cjs');
const chat=path.resolve(__dirname,'..');
const {NativeSyncAdapter,validatePullPage}=require(path.join(chat,'modules/services/nativeSync/adapter'));
const {HistoryMutationQueue}=require(path.join(chat,'modules/services/historyMutationQueue'));
const {durableJson}=require(path.join(chat,'modules/services/nativeSync/durableJson'));
const selected={itemId:'allowed-owner',itemType:'agent',topicId:'allowed-topic'},wire={ownerType:'agent',ownerId:selected.itemId,topicId:selected.topicId};
const quiet={log(){},warn(){},error(){}};
async function fixture(t,{last=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-p1-pull-')),store=new CentralStore(path.join(root,'central.sqlite'));
 const op=(id,owner='allowed-owner')=>({ownerType:'agent',ownerId:owner,topicId:selected.topicId,msgId:id,deviceId:'producer',opId:'put-'+id,action:'upsert',baseHash:null,message:{id,role:'user',content:owner==='allowed-owner'?'synthetic authorized '+id:'DENIED_CONTENT_MARKER',timestamp:1}});
 store.apply(op('one'));let prior;
 for(let seq=2;seq<=150;seq++){
  if(seq%2===0){const raw=op('denied-'+seq,'not-authorized');prior={raw,ack:store.apply(raw)};}
  else store.apply({...prior.raw,opId:'delete-'+seq,action:'delete',baseHash:prior.ack.hash,message:null});
 }
 if(last)store.apply(op('last'));
 const token='synthetic-scoped-pull-only';
 const server=http.createServer((q,r)=>{
  if(q.headers.authorization!=='Bearer '+token){r.writeHead(401);r.end('{}');return;}
  const url=new URL(q.url,'http://localhost');
  const result=store.pull(Number(url.searchParams.get('after_seq')||0),Number(url.searchParams.get('limit')||100),[JSON.stringify(['agent',selected.itemId,selected.topicId])]);
  r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify(result));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const clients=[];t.after(async()=>{for(const c of clients){await c.adapter.close();await c.queue.dispose();}server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await fs.rm(root,{recursive:true,force:true});});
 async function client(name,options={}){
  const queue=new HistoryMutationQueue({userDataDir:path.join(root,name,'UserData'),logger:quiet}),file=path.join(root,name,'sync.json');
  const adapter=await NativeSyncAdapter.open({queue,statePath:file,deviceId:'consumer',url:'http://127.0.0.1:'+server.address().port,token,topics:[selected],...options});
  const result={queue,adapter,file};clients.push(result);return result;
 }
 return {root,store,client,url:'http://127.0.0.1:'+server.address().port,token,clients};
}
test('P1-C: scoped global windows hide both unauthorized messages and tombstones while advancing over empty pages',async t=>{
 const f=await fixture(t),c=await f.client('normal');
 await c.adapter.applyRemote(f.store.pull(0,1).events[0]);assert.equal(c.adapter.state.cursor,1);
 const empty=f.store.pull(1,100,[JSON.stringify(['agent',selected.itemId,selected.topicId])]);
 assert.equal(empty.events.length,0);assert.equal(empty.nextSeq,101);assert.equal(empty.headSeq,151);assert.equal(empty.hasMore,true);
 const response=await fetch(f.url+'/api/v1/sync/pull?after_seq=1&limit=100',{headers:{Authorization:'Bearer '+f.token}});assert.equal(response.status,200);
 const body=await response.text();assert.equal(body.includes('DENIED_CONTENT_MARKER'),false);assert.equal(body.includes('not-authorized'),false);assert.equal(body.includes('denied-'),false);
 await c.adapter.pull({limit:100});assert.equal(c.adapter.state.cursor,151);assert.equal(c.adapter.state.pending,null);assert.equal(c.adapter.state.outbox.length,0);
 assert.deepEqual((await c.queue.read(selected)).map(m=>m.id),['one','last']);
 assert.equal(Object.keys(c.adapter.state.acked).length,2);assert.equal((await fs.readdir(c.queue.userDataDir)).includes('not-authorized'),false);
 assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
test('P1-C: all-empty final windows advance durably and an exactly full terminal page stops without skipping',async t=>{
 const f=await fixture(t,{last:false}),c=await f.client('last-empty');await c.adapter.applyRemote(f.store.pull(0,1).events[0]);await c.adapter.pull({limit:100});
 assert.equal(c.adapter.state.cursor,150);assert.deepEqual((await c.queue.read(selected)).map(m=>m.id),['one']);assert.equal(JSON.parse(await fs.readFile(c.file,'utf8')).cursor,150);
 const all=f.store.pull(0,100);assert.equal(all.events.length,100);assert.equal(all.nextSeq,100);assert.equal(all.hasMore,true);
 const full=f.store.pull(50,100);assert.equal(full.events.length,100);assert.equal(full.nextSeq,150);assert.equal(full.hasMore,false);
 const terminal=f.store.pull(150,100,[]);assert.deepEqual(terminal.events,[]);assert.equal(terminal.nextSeq,150);assert.equal(terminal.hasMore,false);
});
test('P1-C: crash after history commit retains pending and cannot checkpoint past the unapplied ACK',async t=>{
 const f=await fixture(t);let enabled=false,crashed=false;
 const c=await f.client('recovery',{persist:async(file,value)=>{if(enabled&&!crashed&&value.cursor===151&&!value.pending){crashed=true;throw Object.assign(Error('synthetic disk interruption'),{code:'ENOSPC'});}await durableJson(file,value);}});
 await c.adapter.applyRemote(f.store.pull(0,1).events[0]);enabled=true;
 await assert.rejects(c.adapter.pull({limit:100}),e=>e.code==='SYNC_STATE_NOT_DURABLE');
 const disk=JSON.parse(await fs.readFile(c.file,'utf8'));assert.equal(disk.cursor,101);assert.equal(disk.pending.event.seq,151);assert.ok(disk.pending.beforeRevision);assert.ok(disk.pending.afterRevision);
 assert.deepEqual((await c.queue.read(selected)).map(m=>m.id),['one','last']);
 await c.adapter.close();await c.queue.dispose();f.clients.splice(f.clients.indexOf(c),1);
 const queue=new HistoryMutationQueue({userDataDir:c.queue.userDataDir,logger:quiet});
 const adapter=await NativeSyncAdapter.open({queue,statePath:c.file,deviceId:'consumer',url:f.url,token:f.token,topics:[selected]});f.clients.push({queue,adapter});
 await adapter.pull({limit:100});assert.equal(adapter.state.cursor,151);assert.equal(adapter.state.pending,null);assert.equal(adapter.state.outbox.length,0);assert.equal(adapter.degraded,null);
 assert.deepEqual((await queue.read(selected)).map(m=>m.id),['one','last']);
 const again=JSON.parse(await fs.readFile(c.file,'utf8'));assert.equal(again.cursor,151);assert.equal(again.pending,null);
});

test('P1-C: failed empty-window checkpoint is retried from its last durable cursor after restart',async t=>{
 const f=await fixture(t);let injected=false;
 const c=await f.client('empty-checkpoint',{persist:async(file,value)=>{
  if(!injected&&value.cursor===101&&!value.pending){injected=true;throw Object.assign(Error('synthetic checkpoint failure'),{code:'ENOSPC'});}
  await durableJson(file,value);
 }});
 await c.adapter.applyRemote(f.store.pull(0,1).events[0]);
 await assert.rejects(c.adapter.pull({limit:100}),e=>e.code==='ENOSPC');
 const disk=JSON.parse(await fs.readFile(c.file,'utf8'));assert.equal(disk.cursor,1);assert.equal(disk.pending,null);
 assert.deepEqual((await c.queue.read(selected)).map(m=>m.id),['one']);
 await c.adapter.close();await c.queue.dispose();f.clients.splice(f.clients.indexOf(c),1);
 const queue=new HistoryMutationQueue({userDataDir:c.queue.userDataDir,logger:quiet});
 const adapter=await NativeSyncAdapter.open({queue,statePath:c.file,deviceId:'consumer',url:f.url,token:f.token,topics:[selected]});f.clients.push({queue,adapter});
 await adapter.pull({limit:100});assert.equal(adapter.state.cursor,151);assert.equal(adapter.state.pending,null);
 assert.deepEqual((await queue.read(selected)).map(m=>m.id),['one','last']);assert.equal(adapter.state.outbox.length,0);
});
test('P1-C: malformed, rewinding, stalled and inconsistent pagination is rejected before page checkpoint',async t=>{
 const f=await fixture(t);let response;
 const c=await f.client('bad-server',{request:async()=>response});await c.adapter.transaction(next=>{next.cursor=10;});
 const good={events:[],headSeq:20,nextSeq:20,hasMore:false};
 const cases=[{...good,nextSeq:undefined},{...good,nextSeq:9},{...good,headSeq:9,nextSeq:9},{...good,nextSeq:21},{...good,nextSeq:10,hasMore:true},{...good,nextSeq:15},{...good,hasMore:1},{...good,events:[{seq:21}]},{...good,events:[{seq:12},{seq:12}]},{...good,events:[{seq:10}]}];
 for(const value of cases){response=value;await assert.rejects(c.adapter.pull({limit:100}),e=>['INVALID_PULL_CURSOR','PAGINATION_STALLED','CURSOR_REWIND'].includes(e.code));assert.equal(c.adapter.state.cursor,10);assert.equal(c.adapter.state.pending,null);}
 const unauthorized=f.store.pull(0,3).events[1];response={events:[{...unauthorized,seq:11}],headSeq:11,nextSeq:11,hasMore:false};await assert.rejects(c.adapter.pull(),e=>e.code==='OWNER_BINDING_MISMATCH');assert.equal(c.adapter.state.cursor,10);assert.deepEqual(await c.queue.read(selected),[]);
 assert.doesNotThrow(()=>validatePullPage({events:[],headSeq:10,nextSeq:10,hasMore:false},10,100));
});
