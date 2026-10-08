import test from 'node:test'; import assert from 'node:assert/strict'; import { createMainChatThemeOwner } from '../modules/renderer/mainChatThemeOwner.js';
const body=()=>({classList:{values:new Set(),remove(...xs){xs.forEach(x=>this.values.delete(x));},add(x){this.values.add(x);}},removeAttribute(){}});
test('theme owner applies and rolls back failed presentation persistence', async()=>{ const settings={chatPresentationMode:'bubble'}; const b=body(); const owner=createMainChatThemeOwner({settingsOwner:{get:()=>settings,update:(k,v)=>settings[k]=v},documentRef:{body:b},saveSettings:async()=>({success:false,error:'no'}),scheduleFrame:fn=>fn(),notify:()=>{}}); const result=await owner.applyPresentation('panel',{persist:true}); assert.equal(result.success,false); assert.equal(settings.chatPresentationMode,'bubble'); assert.equal(b.classList.values.has('chat-presentation-bubble'),true); });
test('theme owner ignores work after dispose',()=>{ const b=body(); const owner=createMainChatThemeOwner({settingsOwner:{get:()=>({chatPresentationMode:'bubble'}),update(){}},documentRef:{body:b}}); owner.dispose(); owner.applyInitialTheme('dark'); assert.equal(b.classList.values.size,0); });

test('messenger persists as a distinct mode and retracts when switching back', async () => {
    const settings = { chatPresentationMode: 'bubble' };
    const pageBody = body();
    const saved = [];
    const projected = [];
    const owner = createMainChatThemeOwner({
        settingsOwner: { get: () => settings, update: (key, value) => { settings[key] = value; } },
        documentRef: { body: pageBody },
        saveSettings: async patch => { saved.push(patch); return { success: true }; },
        pretextBridge: { setPresentationMode: value => projected.push(value) }
    });
    assert.equal((await owner.applyPresentation('messenger', { persist: true })).success, true);
    assert.equal(settings.chatPresentationMode, 'messenger');
    assert.deepEqual(saved, [{ chatPresentationMode: 'messenger' }]);
    assert.equal(pageBody.classList.values.has('chat-presentation-messenger'), true);
    await owner.applyPresentation('bubble');
    assert.deepEqual(projected, ['messenger', 'bubble']);
    assert.equal(pageBody.classList.values.has('chat-presentation-messenger'), false);
    assert.equal(pageBody.classList.values.has('chat-presentation-bubble'), true);
});
