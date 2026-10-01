import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createNotesSideProvider} from '../modules/ui-system/side-pane/notesSideProvider.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
const save=doc=>doc.getElementById('view').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}));

test('new note waits for an old in-flight write and never reuses its file path',async()=>{
    const dom=new JSDOM('<div id="view"></div>');const doc=dom.window.document;const started=deferred(),pending=deferred(),saves=[];
    const provider=createNotesSideProvider({electronAPI:{readNotesTree:async()=>[],saveMiniNote:async payload=>{saves.push(payload);if(saves.length===1){started.resolve();return pending.promise;}return {success:true,path:'new-note.md'};}}});
    const handle=await provider.mountTab({id:'notes'},doc.getElementById('view'));const title=doc.querySelector('input'),body=doc.querySelector('textarea'),select=doc.querySelector('select');
    title.value='Old';body.value='old content';save(doc);await started.promise;
    select.value='__new__';select.dispatchEvent(new dom.window.Event('change'));await settle();
    assert.equal(body.value,'old content','switch cannot clear the unsaved editor while its write is pending');
    assert.equal(body.disabled,true);
    pending.resolve({success:true,path:'old-note.md'});await settle();
    assert.equal(body.value,'');assert.equal(body.disabled,false);
    title.value='New';body.value='new content';save(doc);await settle();
    assert.equal(saves[1].title,'New');assert.equal(saves[1].filePath,null);
    await handle.dispose();dom.window.close();
});

test('a failed write preserves the editor on switch and blocks disposal until retry succeeds',async()=>{
    const dom=new JSDOM('<div id="view"></div>');const doc=dom.window.document;let fail=true;
    const provider=createNotesSideProvider({electronAPI:{readNotesTree:async()=>[],saveMiniNote:async()=>fail?{success:false,error:'disk-full'}:{success:true,path:'retry.md'}}});
    const handle=await provider.mountTab({id:'notes'},doc.getElementById('view'));doc.querySelector('input').value='Unsaved';doc.querySelector('textarea').value='keep me';
    doc.querySelector('[data-action="new-note"]').click();await settle();
    assert.equal(doc.querySelector('textarea').value,'keep me');
    await assert.rejects(handle.dispose(),/尚未保存/);assert.ok(doc.querySelector('textarea'));
    fail=false;await handle.dispose();assert.equal(doc.getElementById('view').children.length,0);dom.window.close();
});

test('external editor replacement cannot inherit an old save completion, and close waits for all current edits',async()=>{
    const dom=new JSDOM('<div id="view"></div>');const doc=dom.window.document;const pending=deferred(),started=deferred(),saves=[];
    const provider=createNotesSideProvider({electronAPI:{readNotesTree:async()=>[],saveMiniNote:async payload=>{saves.push(payload);if(saves.length===1){started.resolve();return pending.promise;}return {success:true,path:payload.filePath};}}});
    const handle=await provider.mountTab({id:'notes'},doc.getElementById('view'));doc.querySelector('input').value='Old';doc.querySelector('textarea').value='old';save(doc);await started.promise;
    handle.setNote({title:'Other',content:'new',filePath:'other-note.md'});doc.querySelector('textarea').value='new edit';
    const closing=handle.dispose();pending.resolve({success:true,path:'old-note.md'});await closing;
    assert.equal(saves[1].filePath,'other-note.md');assert.equal(saves[1].content,'new edit');dom.window.close();
});

test('grab uses the real message DOM, skips unfinished replies and excludes message chrome',async()=>{
    const dom=new JSDOM('<div id="chatMessages"><div class="message-item assistant"><button>copy</button><div class="md-content">Real reply</div></div><div class="message-item assistant is-streaming"><div class="md-content">Unfinished</div></div></div><div id="view"></div>');const doc=dom.window.document;
    const provider=createNotesSideProvider({electronAPI:{readNotesTree:async()=>[],saveMiniNote:async()=>({success:true,path:'excerpt.md'})}});
    const handle=await provider.mountTab({id:'notes'},doc.getElementById('view'));doc.querySelector('[data-action="grab-from-chat"]').click();
    const text=doc.querySelector('textarea').value;assert.ok(text.includes('Real reply'));assert.ok(!text.includes('copy'));assert.ok(!text.includes('Unfinished'));
    await handle.dispose();dom.window.close();
});
