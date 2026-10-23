'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {messageHash,messageKey,wireTopic,identity,tombstoneHash,fail}=require('./protocol');
const {validatePullPage}=require('./adapter');

// First attachment must compare the complete selected source against the latest
// central projection before capture can enqueue or publish any local message.
async function initialImport({queue,appDataRoot,connection,request}){
 const statePath=path.join(appDataRoot,'.native-sync','state.json');
 try{const s=await fs.lstat(statePath);if(s.isSymbolicLink()||s.nlink>1)throw fail('SYNC_STATE_ALIAS');return {existingState:true};}catch(e){if(e.code!=='ENOENT')throw e;}
 const selected=new Map(),local=new Map();let localMessages=0;
 for(const d of connection.topics){
  const id=wireTopic(d),key=JSON.stringify([id.ownerType,id.ownerId,id.topicId]);if(selected.has(key))throw fail('DUPLICATE_SELECTED_TOPIC');selected.set(key,id);
  const approved=connection.approvedHistory?.find(x=>x.itemId===d.itemId&&x.topicId===d.topicId&&x.itemType===(d.itemType||'agent'));
  if(!approved||!/^[a-f0-9]{64}$/.test(approved.rawFileSha256))throw fail('APPROVED_HISTORY_SNAPSHOT_REQUIRED');
  const file=queue.getHistoryPath(d.itemId,d.topicId);let current=path.resolve(queue.userDataDir);
  for(const part of ['',...path.relative(current,file).split(path.sep)]){if(part)current=path.join(current,part);const s=await fs.lstat(current);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw fail('OWNER_PATH_ALIAS');}
  const bytes=await fs.readFile(file);if(crypto.createHash('sha256').update(bytes).digest('hex')!==approved.rawFileSha256)throw fail('APPROVED_HISTORY_CHANGED');
  const history=JSON.parse(bytes);if(!Array.isArray(history))throw fail('INVALID_HISTORY');
  for(const m of history){if(typeof m.id!=='string'||!m.id)throw fail('MISSING_MESSAGE_ID');const k=messageKey({...id,msgId:m.id});if(local.has(k))throw fail('DUPLICATE_MESSAGE_ID');local.set(k,messageHash(m));localMessages++;}
 }
 const remote=new Map();let cursor=0;
 for(let page=0;;page++){
  if(page>=10000)throw fail('INITIAL_IMPORT_PAGE_LIMIT');
  const r=await request(`/api/v1/sync/pull?after_seq=${cursor}&limit=500`);
  validatePullPage(r,cursor,500);
  for(const event of r.events){
   const id=identity(event);if(!Number.isSafeInteger(event.seq)||event.seq<=cursor)throw fail('CURSOR_REWIND');cursor=event.seq;
   if(!['delete','upsert'].includes(event.action)||event.hash!==(event.action==='delete'?tombstoneHash(id):messageHash(event.message))||(event.action==='upsert'&&event.message.id!==id.msgId))throw fail('CORRUPT_EVENT');
   // The first daily-use central store is explicitly dedicated to this selected
   // set. Do not silently skip another owner's data or advance its cursor.
   if(!selected.has(JSON.stringify([id.ownerType,id.ownerId,id.topicId])))throw fail('CENTRAL_CONTAINS_UNSELECTED_TOPICS');
   remote.set(messageKey(id),event);
  }
  cursor=r.nextSeq;
  if(!r.hasMore)break;
 }
 let matched=0;
 for(const [key,hash] of local){const r=remote.get(key);if(!r)continue;if(r.action==='delete')throw fail('INITIAL_IMPORT_REMOTE_TOMBSTONE');if(r.hash!==hash)throw fail('INITIAL_IMPORT_CONTENT_CONFLICT');matched++;}
 return {existingState:false,selectedTopics:selected.size,localMessages,identicalRemoteMessages:matched,newLocalMessages:localMessages-matched,remoteOnlyMessages:[...remote].filter(([key,event])=>!local.has(key)&&event.action!=='delete').length,historyWritten:false,centralWritten:false};
}
module.exports={initialImport};
