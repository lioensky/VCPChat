'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {identity,fail}=require('./protocol');

// Only a projected directory leaves the desktop. Never serialize Agent config,
// prompt, API key, provider options, filesystem paths or history message bodies.
async function catalog({appDataRoot,topics,readAgentConfig,thumbnail}){
 const root=path.resolve(appDataRoot),rows=[];
 for(const d of topics){
  identity({ownerType:d.itemType||'agent',ownerId:d.itemId,topicId:d.topicId,msgId:'_'});
  if((d.itemType||'agent')!=='agent')throw fail('MOBILE_AGENT_TOPICS_ONLY');
  const config=await readAgentConfig(d.itemId),topic=config.topics?.find(t=>t.id===d.topicId);if(!topic)throw fail('SELECTED_TOPIC_NOT_IN_AGENT');
  const file=path.join(root,'UserData',d.itemId,'topics',d.topicId,'history.json');const stat=await fs.stat(file);
  let avatar=null;
  if(thumbnail)for(const ext of ['.png','.jpg','.jpeg','.gif','.webp']){
   const image=path.join(root,'Agents',d.itemId,'avatar'+ext);
   try{const s=await fs.lstat(image);if(s.isSymbolicLink()||s.nlink>1)throw fail('AVATAR_PATH_ALIAS');avatar=await thumbnail(image);break;}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  rows.push({ownerId:d.itemId,ownerType:'agent',topicId:d.topicId,agentName:String(config.name||d.itemId).slice(0,200),topicName:String(topic.name||d.topicId).slice(0,500),updatedAt:Math.floor(stat.mtimeMs),avatar});
 }
 return {topics:rows};
}
module.exports={catalog};
