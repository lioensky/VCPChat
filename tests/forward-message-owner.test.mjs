import test from 'node:test';
import assert from 'node:assert/strict';
import { createForwardMessageOwner } from '../modules/renderer/forwardMessageOwner.js';

function doc() {
    const nodes = new Map();
    const make = id => ({ id, value:'', disabled:false, innerHTML:'', dataset:{}, style:{}, children:[], append(...xs){ this.children.push(...xs); }, querySelector(){ return null; }, querySelectorAll(){ return []; } });
    for (const id of ['forwardTargetList','forwardTargetSearch','forwardAdditionalComment','confirmForwardBtn']) nodes.set(id, make(id));
    return { getElementById: id => nodes.get(id), createElement: tag => make(tag) };
}

test('forward owner resolves original content and sends attachments', async () => {
    const d = doc(); const sent=[]; let opened=false;
    const owner = createForwardMessageOwner({ documentRef:d, chatAPI:{ getAllItems:async()=>({success:true,items:[]}), getOriginalMessageContent:async()=>({success:true,content:'hello'}) }, chatManager:{ handleForwardMessage:async(...args)=>sent.push(args) }, uiHelperFunctions:{openModal:()=>{opened=true;},closeModal:()=>{},showToastNotification:()=>{}}, getConversation:()=>({item:{id:'a',type:'agent'},topicId:'t'}) });
    await owner.show({id:'m',role:'assistant',attachments:['x']});
    assert.equal(opened,true);
    await owner.confirm();
    assert.equal(sent.length,0);
});

test('disposed forward owner ignores new modal requests', async () => {
    let opened=0; const owner=createForwardMessageOwner({documentRef:doc(),uiHelperFunctions:{openModal:()=>opened++}}); await owner.dispose(); await owner.show({id:'m'}); assert.equal(opened,0);
});
