'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { GsvPresetStore, validateWav, synthesize } = require('../modules/voice/gsvPresets');
const { createManager } = require('../sovits5cppmanager/server');

function wav(seconds = 4) {
    const bytes = 16000 * 2 * seconds;
    const b = Buffer.alloc(44 + bytes);
    b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
    b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34);
    b.write('data',36); b.writeUInt32LE(bytes,40);
    return b;
}
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsv-test-'));
    t.after(() => fs.rm(root, {recursive:true,force:true}));
    const store = new GsvPresetStore(root);
    const {audio} = await store.importAudio(wav());
    const p = {id:'kerr',name:'凯尔 · 开心',audio,promptText:'你好',emotion:'开心',promptLang:'all_zh',textLang:'all_ja',speed:1.2,engineVoice:'default',sampleSteps:4};
    await store.save(p);
    return {store,p,root};
}
async function listen(t, server) {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}
test('PCM WAV 校验及音频长度边界', () => {
    assert.equal(validateWav(wav()).duration,4);
    assert.throws(() => validateWav(wav(1)), /3–10/);
    assert.throws(() => validateWav(Buffer.from('bad')), /PCM WAV/);
    assert.throws(() => validateWav(wav().subarray(0,100)), /截断/);
});
test('预设原子串行写入、唯一名称、路径与内容完整性', async t => {
    const {store,p,root} = await fixture(t);
    assert.equal((await store.resolve('gsv:kerr')).name,p.name);
    await Promise.all([store.save({...p,id:'b',name:'乙'}),store.save({...p,id:'c',name:'丙'})]);
    assert.equal((await store.read()).presets.length,3);
    await assert.rejects(store.save({...p,id:'d'}), /重复/);
    assert.throws(() => store.save({...p,audio:'../secret.wav'}), /托管/);
    await store.remove('b');
    assert.equal((await store.read()).presets.length,2);
    await fs.writeFile(path.join(root,'refs',p.audio),wav(5));
    await assert.rejects(store.audio(p), /变化/);
});
test('GSV 实际 HTTP 契约：上传ASCII名、独立语言、速度相乘、拒绝中文返回路径', async t => {
    const {store,p} = await fixture(t);
    let payload, chinese = false, uploaded = false;
    const baseUrl = await listen(t,http.createServer(async (req,res) => {
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        if (req.url.startsWith('/reference?')) {
            uploaded = true;
            assert.match(req.url, /^\/reference\?name=[a-f0-9]{64}\.wav$/);
            assert.equal(Buffer.concat(chunks).length,wav().length);
            res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({path:chinese ? 'C:/用户/ref.wav' : 'C:/temp/ref.wav'}));
        } else {
            payload = JSON.parse(Buffer.concat(chunks).toString());
            res.setHeader('Content-Type','audio/wav'); res.end(wav());
        }
    }));
    const result = await synthesize({store,preset:p,baseUrl,text:'こんにちは',speed:1.5});
    assert.equal(result.length,wav().length); assert.ok(uploaded);
    assert.equal(payload.prompt_lang,'all_zh'); assert.equal(payload.text_lang,'all_ja');
    assert.ok(Math.abs(payload.speed_factor-1.8)<1e-12);
    assert.equal(payload.voice,'default'); assert.equal(payload.emotion,undefined);
    chinese = true;
    await assert.rejects(synthesize({store,preset:p,baseUrl,text:'x'}), /非 ASCII/);
});
test('管理器读取、CRUD及跨源拒绝', async t => {
    const {store,p} = await fixture(t);
    const base = await listen(t,createManager({store}));
    assert.equal((await (await fetch(`${base}/api/presets`)).json()).presets.length,1);
    assert.equal((await fetch(`${base}/api/presets`,{method:'POST',body:'{}'})).status,403);
    assert.equal((await fetch(`${base}/api/presets`,{headers:{Origin:'https://evil.example'}})).status,403);
    const saved = await fetch(`${base}/api/presets`,{method:'POST',headers:{'X-GSV-Manager':'1'},body:JSON.stringify({...p,name:'新名字'})});
    assert.equal(saved.status,200);
    assert.equal((await store.resolve(p.id)).name,'新名字');
    assert.equal((await fetch(base)).status,200);
});