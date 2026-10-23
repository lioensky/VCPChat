'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const source=path.resolve(__dirname,'..');
const req=createRequire(path.join(source,'package.json'));
const {HistoryMutationQueue}=req('./modules/services/historyMutationQueue');
const {NativeSyncAdapter}=req('./modules/services/nativeSync/adapter');
const {messageKey,messageHash}=req('./modules/services/nativeSync/protocol');
const quiet={log(){},warn(){},error(){}};
const topic={itemId:'synthetic-agent',itemType:'agent',topicId:'shared'};
function load(relative,overrides=new Map(),globals={}){
 const file=path.join(source,relative),mod={exports:{}},fallback=createRequire(file);
 return fs.readFile(file,'utf8').then(code=>{
  vm.runInNewContext('(function(require,module,exports,__dirname){'+code+'\n})',{console:quiet,Buffer,URL,TextDecoder,TextEncoder,fetch,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,process,...globals},{filename:file})(n=>overrides.has(n)?overrides.get(n):fallback(n),mod,mod.exports,path.dirname(file));return mod.exports;
 });
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'final-p1-')),userDataDir=path.join(root,'UserData');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const queue=new HistoryMutationQueue({userDataDir,logger:quiet});t.after(()=>queue.dispose());
 const history=[{id:'old',role:'user',content:'synthetic original',timestamp:1}];
 await fs.mkdir(path.dirname(queue.getHistoryPath(topic.itemId,topic.topicId)),{recursive:true});await fs.writeFile(queue.getHistoryPath(topic.itemId,topic.topicId),JSON.stringify(history));
 const config={name:'Synthetic',topics:[{id:'shared'},{id:'other'}]};
 const AGENT_DIR=path.join(root,'Agents');await fs.mkdir(path.join(AGENT_DIR,topic.itemId),{recursive:true});await fs.writeFile(path.join(AGENT_DIR,topic.itemId,'config.json'),JSON.stringify(config));
 const manager={readAgentConfig:async()=>structuredClone(config),updateAgentConfig:async(_id,fn)=>{Object.assign(config,fn(structuredClone(config)));return structuredClone(config);}};
 const routes=new Map(),ipcMain={handle:(n,f)=>routes.set(n,f),removeHandler(){},on(){}};
 const trajectory={clearTrajectoriesOfOwner:async()=>{},clearTrajectoryOf:async()=>{},beginTrajectoryCall:()=>({}),sessionKeyFromContext(){},sourceFromContext(){}};
 const common=new Map([['electron',{ipcMain,dialog:{},BrowserWindow:{}}],['../modelTrajectory',trajectory]]);
 const agent=await load('modules/ipc/agentHandlers.js',new Map([...common,['../services/agentPortraitImages',{forgetPortraitDisplayImages:async()=>{}}]]));
 agent.initialize({AGENT_DIR,USER_DATA_DIR:userDataDir,agentConfigManager:manager,historyMutationQueue:queue});
 const chat=await load('modules/ipc/chatHandlers.js',new Map([...common,['../services/attachmentDialogState',{}],['../../Groupmodules/topicTitleManager',{}],['./workspaceHandlers',{}],['./sideChatHandlers',{removeSideChatChildrenOfParent:async()=>{}}]]));
 chat.initialize(null,{AGENT_DIR,USER_DATA_DIR:userDataDir,APP_DATA_ROOT_IN_PROJECT:root,agentConfigManager:manager,historyMutationQueue:queue});
 return {root,queue,history,config,call:(name,...args)=>routes.get(name)({},...args)};
}
test('shared Topic/Agent delete IPC refuses before any config/history change, including concurrent Queue work',async t=>{
 const f=await fixture(t);f.queue.configureSync({topics:[topic]});
 let release;const gate=new Promise(r=>release=r),pending=f.queue.run(topic,()=>gate);
 const before=await fs.readFile(f.queue.getHistoryPath(topic.itemId,topic.topicId));
 try{for(const [name,args]of [['delete-topic',[topic.itemId,topic.topicId]],['delete-agent',[topic.itemId]]]){
  const result=await f.call(name,...args);assert.equal(result.code,'SYNC_WRITER_EXCLUDED');
  assert.deepEqual(await fs.readFile(f.queue.getHistoryPath(topic.itemId,topic.topicId)),before);assert.equal(f.config.topics.length,2);
 }}finally{release();await pending;}
});
test('nonshared Topic delete and NativeSync-off Agent delete preserve original behavior',async t=>{
 const f=await fixture(t);f.queue.configureSync({topics:[topic]});
 assert.equal((await f.call('delete-topic',topic.itemId,'other')).success,true);
 f.queue.configureSync();assert.equal((await f.call('delete-agent',topic.itemId)).success,true);
 await assert.rejects(fs.stat(path.join(f.queue.userDataDir,topic.itemId)),e=>e.code==='ENOENT');
});
