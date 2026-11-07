'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {JSDOM} = require('jsdom');

test('管理页加载预设、编辑、保存与新建', async t => {
    const html = await fs.readFile(path.resolve(__dirname,'../sovits5cppmanager/index.html'),'utf8');
    const code = await fs.readFile(path.resolve(__dirname,'../sovits5cppmanager/app.js'),'utf8');
    const dom = new JSDOM(html,{runScripts:'outside-only',url:'http://127.0.0.1:9885'});
    t.after(()=>dom.window.close());
    const p = {id:'a',name:'中文音色',audio:'a'.repeat(64)+'.wav',promptText:'你好',emotion:'开心',promptLang:'all_zh',textLang:'auto',speed:1.2,engineVoice:'default',sampleSteps:4};
    let saved;
    dom.window.fetch = async (url, options) => ({
        ok:true,
        headers:{get:()=> 'application/json'},
        json:async()=> {
            if(options.method==='POST') {saved=JSON.parse(options.body);return {version:1,presets:[saved]};}
            return {presets:[p],languages:['all_zh','auto']};
        }
    });
    dom.window.eval(code);
    const settle = () => new Promise(r=>setTimeout(r,20));
    await settle();
    const doc = dom.window.document, form = doc.querySelector('#editor');
    doc.querySelector('#list button').click();
    assert.equal(form.elements.name.value,'中文音色');
    assert.equal(form.elements.promptLang.value,'all_zh');
    form.elements.name.value='新名称';
    form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await settle();
    assert.equal(saved.name,'新名称');
    assert.equal(saved.speed,1.2);
    assert.equal(saved.audio,p.audio);
    doc.querySelector('#new').click();
    assert.notEqual(form.elements.id.value,'a');
    assert.equal(form.elements.audio.value,'');
    assert.equal(doc.querySelector('#status').textContent,'完成');
});

test('主程序本地列表消费预设；网络MiMo列表不依赖GSV', async () => {
    const TTS = require('../modules/SovitsTTS');
    const instance = Object.create(TTS.prototype);
    instance.getRuntimeConfig = async()=>({voiceMode:'local',baseUrl:'http://127.0.0.1:9880'});
    instance.gsvStore = {read:async()=>({presets:[{id:'a',name:'中文名'}]})};
    assert.deepEqual(await instance.getModels(),[{id:'gsv:a',voice:'gsv:a',displayName:'中文名',type:'gsv-preset'}]);
    instance.getRuntimeConfig = async()=>({voiceMode:'network'});
    instance._scanCloneAudioFiles = async()=>[];
    const network = await instance.getModels();
    assert.ok(network.some(p=>p.voice==='mimo_default'));
    assert.ok(!network.some(p=>p.voice.startsWith('gsv:')));
});