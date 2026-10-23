'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),fromSource=createRequire(path.join(root,'modules/services/nativeSync/adapter.js'));
const protocol=fromSource('./protocol');
const topic={itemId:'performance-owner',itemType:'agent',topicId:'performance-topic'};
const message=i=>({id:'message-'+i,role:i%2?'assistant':'user',content:'synthetic text '+i,timestamp:i+1});
function makeFixture(n){
 const duplicates=n/5,latest=n-duplicates,history=[];const outbox=[],acked={};
 const wire={ownerType:'agent',ownerId:topic.itemId,topicId:topic.topicId};
 for(let i=0;i<duplicates;i++){
  const foreign=i>=duplicates-10,id=foreign?'foreign-'+i:'message-'+i,m={...message(i),id,content:'synthetic older '+i};
  outbox.push({...wire,...(foreign?{ownerId:'other-owner'}:{}),msgId:id,deviceId:'performance-device',opId:'older-'+i,action:'upsert',baseHash:null,message:m});
 }
 for(let i=0;i<latest;i++){
  const deleted=i>=Math.floor(latest*.75)&&i<Math.floor(latest*.825);
  const previous=i<duplicates-10?protocol.messageHash({...message(i),content:'synthetic older '+i}):null;
  outbox.push({...wire,msgId:'message-'+i,deviceId:'performance-device',opId:'latest-'+i,action:deleted?'delete':'upsert',baseHash:previous,message:deleted?null:message(i)});
 }
 for(let i=0;i<n;i++){
  const id=i<Math.floor(latest*.875)?i:i+Math.ceil(latest*.125);
  history.push({...message(id),...(id%2===0?{content:'synthetic changed '+id}:{})});
 }
 for(let i=0;i<150;i++){
  const id={...wire,msgId:'acked-only-'+i},deleted=i>=100;
  acked[protocol.messageKey(id)]={hash:deleted?protocol.tombstoneHash(id):protocol.messageHash({id:id.msgId,role:'user',content:'synthetic acknowledged',timestamp:1}),deleted,seq:i+1};
 }
 return {history,state:{version:1,deviceId:'performance-device',topics:[topic],cursor:0,acked,outbox,pending:null}};
}
function loadAdapter(file,counters){
 const source=fs.readFileSync(file,'utf8'),module={exports:{}};let uuid=0;
 const counted={...protocol};for(const name of ['messageKey','messageHash','canonicalMessage','tombstoneHash'])counted[name]=(...args)=>{counters[name]=(counters[name]||0)+1;return protocol[name](...args);};
 const require=name=>name==='./protocol'?counted:name==='node:crypto'?{...crypto,randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`}:fromSource(name);
 const compile=vm.runInNewContext('(function(require,module,exports,__dirname){'+source+'\n})',{process,console,Buffer,URL,structuredClone,fetch,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval},{filename:file});
 compile(require,module,module.exports,path.dirname(file));return module.exports.NativeSyncAdapter;
}
module.exports={makeFixture,loadAdapter,topic};
