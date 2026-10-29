import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handlers = require('../modules/deskpet/petHandlers.js');
const { createPetAssets } = require('../modules/deskpet/petAssets.js');

const root = path.resolve('/vcp');
const paths = { projectRoot: root, appDataRoot: path.join(root, 'AppData'), agentDir: path.join(root, 'AppData', 'Agents') };
const resolve = (url) => handlers._resolveServedFile(url, paths);
const agentRoot = path.join(paths.agentDir, 'Nova');

test('desk pet protocol serves only the pet page, vendor, core and agent pet files', () => {
    assert.equal(resolve('vcp-deskpet://pet/app/deskpet.html'), path.join(root, 'DeskPetmodules', 'deskpet.html'));
    assert.equal(resolve('vcp-deskpet://pet/vendor/pixi.min.js'), path.join(root, 'vendor', 'pixi.min.js'));
    assert.equal(resolve('vcp-deskpet://pet/emotion/emotionDirector.js'), path.join(root, 'modules', 'emotion', 'emotionDirector.js'));
    assert.equal(resolve('vcp-deskpet://pet/core/live2dcubismcore.min.js'), path.join(paths.appDataRoot, 'deskpet', 'live2dcubismcore.min.js'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/deskpet/Mao/Mao.model3.json'), path.join(agentRoot, 'deskpet', 'Mao', 'Mao.model3.json'));
    assert.equal(resolve('vcp-deskpet://pet/app/puppet.js'), path.join(root, 'DeskPetmodules', 'puppet.js'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/deskpet/nova/nova.puppet.json'), path.join(agentRoot, 'deskpet', 'nova', 'nova.puppet.json'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/portrait.happy.png'), path.join(agentRoot, 'portrait.happy.png'));
    assert.equal(resolve('vcp-deskpet://pet/agent/Nova/avatar.png'), path.join(agentRoot, 'avatar.png'));
    // 助手没放头像时用应用的默认头像
    assert.equal(resolve('vcp-deskpet://pet/default-avatar.png'), path.join(root, 'assets', 'default_avatar.png'));
    assert.equal(resolve('vcp-deskpet://pet/default-avatar.png/x'), null);
});
// 沿真实页面入口检查静态依赖，避免共享模块新增 import 后被协议白名单挡住。
// 假窗口生命周期测试不执行页面模块，无法发现这种启动前失败。
test('the pet entry static module graph is fully served by its protocol', async () => {
    const { parse } = require('@babel/parser');
    const projectRoot = path.resolve('.');
    const assets = createPetAssets({ paths: {
        projectRoot,
        appDataRoot: path.join(projectRoot, 'AppData'),
        agentDir: path.join(projectRoot, 'AppData', 'Agents'),
    } });
    const visited = new Set();
    const visit = async (url, importer = 'page') => {
        if (visited.has(url)) return;
        visited.add(url);
        const file = await assets.resolveLocalFile(url);
        assert.ok(file, `${importer} 的静态依赖无法通过桌宠协议加载：${url}`);
        const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module' });
        for (const node of ast.program.body) {
            if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
            const spec = node.source.value;
            assert.ok(spec.startsWith('.') || spec.startsWith('vcp-deskpet:'), `未支持的页面依赖：${spec}`);
            await visit(new URL(spec, url).href, url);
        }
    };
    await visit('vcp-deskpet://pet/app/deskpet.js');
    assert.ok(visited.has('vcp-deskpet://pet/renderer/toolBatchRegions.js'));
    assert.equal(await assets.resolveLocalFile('vcp-deskpet://pet/renderer/contentPipeline.js'), null,
        '不能为修复依赖而暴露整个 renderer 目录');
});


test('desk pet protocol refuses agent config, history and traversal', () => {
    for (const url of [
        'vcp-deskpet://pet/agent/Nova/config.json',
        'vcp-deskpet://pet/agent/Nova/topics/t1/history.json',
        'vcp-deskpet://pet/agent/Nova/deskpet/..%2Fconfig.json',
        'vcp-deskpet://pet/agent/Nova/deskpet/..%5Cconfig.json',
        'vcp-deskpet://pet/agent/..%2F..%2Fsettings.json/deskpet/x',
        'vcp-deskpet://pet/app/..%2Fmain.js',
        'vcp-deskpet://pet/emotion/..%2F..%2Fmain.js',
        'vcp-deskpet://pet/core/other.js',
        'vcp-deskpet://pet/settings.json',
        'vcp-deskpet://pet/agent/Nova/deskpet/%E0%A4%A',
    ]) {
        assert.equal(resolve(url), null, url);
    }
});

test('real resource paths reject links out of the pet folder, including a linked pet folder itself', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-realpaths-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const agentDir = path.join(dir, 'Agents');
    const petDir = path.join(agentDir, 'Nova', 'deskpet');
    const secretDir = path.join(agentDir, 'Nova', 'topics', 'private');
    fs.mkdirSync(petDir, { recursive: true }); fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(petDir, 'model.json'), '{}');
    fs.writeFileSync(path.join(secretDir, 'history.json'), 'private history');
    fs.symlinkSync(secretDir, path.join(petDir, 'shortcut'), 'junction');
    fs.mkdirSync(path.join(agentDir, 'Linked'));
    fs.symlinkSync(secretDir, path.join(agentDir, 'Linked', 'deskpet'), 'junction');
    const assets = createPetAssets({ paths: { projectRoot: dir, appDataRoot: dir, agentDir } });
    assert.equal(await assets.resolveLocalFile('vcp-deskpet://pet/agent/Nova/deskpet/model.json'), fs.realpathSync(path.join(petDir, 'model.json')));
    for (const url of ['vcp-deskpet://pet/agent/Nova/deskpet/shortcut/history.json', 'vcp-deskpet://pet/agent/Linked/deskpet/history.json',
        'vcp-deskpet://pet/agent/Nova/config.json', 'https://pet/agent/Nova/deskpet/model.json', 'vcp-deskpet://other/agent/Nova/deskpet/model.json']) {
        assert.equal(await assets.resolveLocalFile(url), null, url);
    }
});

test('the pet page uses the Core bundled with the app until the user installs their own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-core-'));
    const own = path.join(dir, 'AppData', 'deskpet', 'live2dcubismcore.min.js');
    const bundled = path.join(dir, 'vendor', 'live2d-cubism-core', 'live2dcubismcore.min.js');
    const assets = createPetAssets({ paths: { projectRoot: dir, appDataRoot: path.join(dir, 'AppData'), agentDir: path.join(dir, 'AppData', 'Agents') } });
    const coreUrl = 'vcp-deskpet://pet/core/live2dcubismcore.min.js';
    assert.equal((await assets.resolveAssets('Nova')).coreUrl, null);

    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, 'bundled');
    assert.match((await assets.resolveAssets('Nova')).coreUrl, /^vcp-deskpet:\/\/pet\/core\/live2dcubismcore\.min\.js\?v=/);
    assert.equal(await assets.resolveLocalFile(coreUrl), fs.realpathSync(bundled));

    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'own');
    assert.equal(await assets.resolveLocalFile(coreUrl), fs.realpathSync(own));
});

test('desk pet protocol prompt is only appended while that agent has a pet open', () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    assert.equal(handlers.appendProtocolToMessages(messages, 'Nova'), messages);
});
