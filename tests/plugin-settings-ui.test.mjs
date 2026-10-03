import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import dotenv from 'dotenv';
import { mountPluginsSettings } from '../modules/ui-system/settings/plugins-settings.js';
import { setEnvValue, envEntries, runtimeLabel, runtimeBadge } from '../modules/ui-system/settings/plugins-settings-model.js';
import { mountGlobalTextInputs } from '../modules/ui-system/settings/global-input-upgrades.js';
import { mountSelect } from '../modules/uiux/generated/primitives/select.js';
import { mountButton } from '../modules/uiux/generated/primitives/button.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
    const dom = new JSDOM('<form><div class="settings-section"><div data-vcp-plugin-settings class="plugins-settings"></div></div></form>');
    const host = dom.window.document.querySelector('.plugins-settings');
    const calls = [];
    const item = { id: 'Fixture', name: 'Fixture', displayName: '测试插件', description: '绘制图片和附件', enabled: true, runtime: 'loaded', connected: true };
    const api = {
        async pluginSettingsList(data) { calls.push(['list', data]); return data.category === 'backend' ? { success: false, error: '请登录管理端' } : { success: true, data: [{ ...item, category: data.category }] }; },
        async pluginSettingsDetail(data) { return { success: true, data: { ...item, ...data, revision: 'version1', config: '# unknown\nCOUNT=2\nAPI_KEY=secret\n', rawManifest: '{}', configSchema: { COUNT: { type: 'integer' }, API_KEY: { type: 'string' } } } }; },
        async pluginSettingsSave(data) { calls.push(['save', data]); return { success: false, error: '插件配置已被其他窗口修改' }; },
        async pluginSettingsToggle(data) { calls.push(['toggle', data]); return { success: true, data: { requiresRestart: true } }; },
    };
    return { dom, host, calls, api, controller: mountPluginsSettings(host, { api }) };
}
test('dotenv values preserve Windows paths, comments, multiline text and unknown secrets', () => {
    const original = '# Keep me\nOTHER=untouched\nCOUNT=2\nCOUNT=3\n';
    for (const value of ['C:\\new\\repo', 'quoted "path"', 'line1\nline2', 'a#b', "it's okay"]) {
        const changed = setEnvValue(original, 'COUNT', value);
        assert.equal(dotenv.parse(changed).COUNT, value); assert.equal(envEntries(changed).find(v => v.key === 'COUNT').value, value);
        assert.ok(changed.includes('# Keep me')); assert.ok(changed.includes('OTHER=untouched'));
        assert.equal(envEntries(changed).filter(v => v.key === 'COUNT').length, 1);
    }
    assert.ok(setEnvValue('COUNT=2 # inline comment\n', 'COUNT', '4').includes(' # inline comment'));
});
test('global text-input enhancement leaves independent plugin controls with their owner', () => {
    const f = fixture();
    const input = f.dom.window.document.createElement('input'); input.type = 'text'; f.host.append(input);
    let mounts = 0;
    mountGlobalTextInputs(f.host.closest('form'), { mountInput() { mounts++; } }, { own() {} });
    assert.equal(mounts, 0); f.controller.dispose();
});
test('lazy tabs, search, draft retention, password masking and failed-save retry', async () => {
    const f = fixture(); assert.equal(f.calls.length, 0);
    f.controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local');
    panel.querySelector('.plugins-card-expand').click(); await tick();
    const count = panel.querySelector('[data-config-key="COUNT"]'); count.value = '8'; count.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    assert.equal(panel.querySelector('[data-config-key="API_KEY"]').type, 'password');
    let globalInputs = 0; f.host.closest('form').addEventListener('input', () => globalInputs++);
    count.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); assert.equal(globalInputs, 0);
    f.controller.select('renderer'); await tick(); f.controller.select('local'); assert.equal(count.value, '8');
    panel.querySelector('.plugins-switch').click(); await tick(); assert.ok(!f.calls.some(c => c[0] === 'toggle'));
    panel.querySelector('.plugins-button-primary').click(); await tick();
    assert.equal(dotenv.parse(f.calls.find(c => c[0] === 'save')[1].config).COUNT, '8');
    assert.ok(panel.textContent.includes('其他窗口')); assert.equal(count.value, '8'); assert.equal(panel.querySelector('.plugins-button-primary').disabled, false);
    const search = panel.querySelector('input[type="search"]'); search.value = 'no-result'; search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    assert.equal(panel.querySelector('.plugins-card').hidden, true); assert.equal(panel.querySelector('.plugins-empty').hidden, false);
    f.controller.select('backend'); await tick(); assert.equal(f.host.querySelector('.plugins-login').hidden, true); // renderer panel's empty login slot
    assert.equal(f.host.querySelector('#plugins-panel-backend .plugins-login').hidden, false);
    f.controller.dispose(); assert.equal(f.host.children.length, 0);
});
test('disposed mount cannot apply a late inventory response; runtime does not equate enable with success', async () => {
    const f = fixture(); let resolve;
    f.api.pluginSettingsList = () => new Promise(r => { resolve = r; });
    f.controller.select('local'); f.controller.dispose(); resolve({ success: true, data: [] }); await tick();
    assert.equal(f.host.children.length, 0);
    assert.equal(runtimeLabel({ category: 'renderer', enabled: true }).text, '未报告加载状态');
    assert.equal(runtimeLabel({ category: 'backend', enabled: true }).text, '后端已注册');
    assert.equal(runtimeLabel({ category: 'local', enabled: true, runtime: 'unloaded' }).text, '本机服务未加载');
});

test('refresh reloads clean details, preserves drafts, and discard recovers from a stale revision', async () => {
    const f = fixture(); let version = 1;
    const original = f.api.pluginSettingsDetail;
    f.api.pluginSettingsDetail = async data => {
        const result = await original(data); result.data.revision = `version${version}`;
        result.data.config = `COUNT=${version}\n`; return result;
    };
    f.api.pluginSettingsSave = async data => { f.calls.push(['save', data]); return { success: data.revision === `version${version}`, data: { requiresRestart: true }, error: '配置已被其他窗口修改' }; };
    f.controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local'); panel.querySelector('.plugins-card-expand').click(); await tick();
    version = 2; await f.controller.refresh();
    assert.equal(panel.querySelector('[data-config-key="COUNT"]').value, '2');
    const edit = value => { const el = panel.querySelector('[data-config-key="COUNT"]'); el.value = value; el.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); };
    edit('9'); version = 3; await f.controller.refresh(); assert.equal(panel.querySelector('[data-config-key="COUNT"]').value, '9');
    panel.querySelector('.plugins-button-primary').click(); await tick(); assert.ok(panel.textContent.includes('其他窗口'));
    [...panel.querySelectorAll('button')].find(el => el.textContent === '放弃更改').click(); await tick();
    assert.equal(panel.querySelector('[data-config-key="COUNT"]').value, '3');
    edit('8'); panel.querySelector('.plugins-button-primary').click(); await tick(); await tick();
    assert.equal(f.calls.filter(c => c[0] === 'save').at(-1)[1].revision, 'version3');
    assert.ok(panel.textContent.includes('已保存')); f.controller.dispose();
});

test('late detail completion after removal does not resurrect a card; removal retains an unsaved draft', async () => {
    const f = fixture(); f.controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local'); let resolve;
    f.api.pluginSettingsDetail = () => new Promise(r => { resolve = r; });
    panel.querySelector('.plugins-card-expand').click();
    f.api.pluginSettingsList = async () => ({ success: true, data: [] });
    await f.controller.refresh(); resolve({ success: true, data: {} }); await tick(); assert.equal(panel.querySelector('.plugins-card'), null); f.controller.dispose();
    const g = fixture(); g.controller.select('local'); await tick();
    const other = g.host.querySelector('#plugins-panel-local'); other.querySelector('.plugins-card-expand').click(); await tick();
    const count = other.querySelector('[data-config-key="COUNT"]'); count.value = '19'; count.dispatchEvent(new g.dom.window.Event('input', { bubbles: true }));
    g.api.pluginSettingsList = async () => ({ success: true, data: [] }); await g.controller.refresh();
    assert.equal(count.value, '19'); assert.ok(other.textContent.includes('未保存的更改已保留')); assert.equal(other.querySelector('.plugins-button-primary').disabled, true); g.controller.dispose();
});

test('shared picker changes config, supports keyboard, syncs raw edits, closes on tab switch and disposal', async t => {
    const f = fixture(); f.controller.dispose();
    const oldWindow = globalThis.window, oldDocument = globalThis.document, oldElement = globalThis.Element;
    globalThis.window = f.dom.window; globalThis.document = f.dom.window.document; globalThis.Element = f.dom.window.Element;
    t.after(() => { globalThis.window = oldWindow; globalThis.document = oldDocument; globalThis.Element = oldElement; f.dom.window.close(); });
    const detail = f.api.pluginSettingsDetail;
    f.api.pluginSettingsDetail = async data => { const result = await detail(data); result.data.configSchema.ENABLED = { type: 'boolean' }; return result; };
    const controller = mountPluginsSettings(f.host, { api: f.api, ui: { mountSelect, mountButton } });
    controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local'); panel.querySelector('.plugins-card-expand').click(); await tick();
    const trigger = panel.querySelector('.vcp-uiux-select-trigger'); trigger.click();
    const menu = f.dom.window.document.querySelector('[role="menu"]'); assert.equal(menu.hidden, false);
    const items = [...menu.querySelectorAll('[role="menuitem"]')]; items[0].focus();
    items[0].dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })); assert.equal(f.dom.window.document.activeElement, items.at(-1));
    items[1].click(); assert.equal(dotenv.parse(panel.querySelector('.plugins-code').value).ENABLED, 'true');
    const raw = panel.querySelector('.plugins-code'); raw.value += 'ENABLED=false\n'; raw.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    assert.ok(trigger.textContent.includes('关闭')); trigger.click(); controller.select('renderer'); assert.equal(f.dom.window.document.querySelector('[role="menu"]'), null);
    controller.select('local'); trigger.click(); controller.dispose(); assert.equal(f.dom.window.document.querySelector('[role="menu"]'), null);
});

test('multiline config remains editable without stripping newlines; disabled renderer is not a load failure', async () => {
    const f = fixture(); const original = f.api.pluginSettingsDetail;
    f.api.pluginSettingsDetail = async data => { const result = await original(data); result.data.config = "TEXT='line1\nline2'\n"; result.data.configSchema = { TEXT: { type: 'string' } }; return result; };
    f.controller.select('local'); await tick(); const panel = f.host.querySelector('#plugins-panel-local'); panel.querySelector('.plugins-card-expand').click(); await tick();
    const control = panel.querySelector('[data-config-key="TEXT"]'); assert.equal(control.tagName, 'TEXTAREA'); assert.equal(control.value, 'line1\nline2');
    assert.equal(runtimeLabel({ category: 'renderer', enabled: false, name: 'Fixture' }, { getLoadState: () => ({ loaded: false }) }).text, '已停用'); f.controller.dispose();
});

test('closing and reopening settings retains drafts and their original revision; reverting fields clears dirty state', async () => {
    const f = fixture(); f.controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local'); panel.querySelector('.plugins-card-expand').click(); await tick();
    const edit = value => { const el = f.host.querySelector('#plugins-panel-local [data-config-key="COUNT"]'); el.value = value; el.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); };
    edit('8'); edit('2'); assert.equal(panel.querySelector('.plugins-button-primary').disabled, true);
    edit('42'); f.controller.dispose();
    const original = f.api.pluginSettingsDetail;
    f.api.pluginSettingsDetail = async data => { const result = await original(data); result.data.revision = 'version2'; return result; };
    const controller = mountPluginsSettings(f.host, { api: f.api }); controller.select('local'); await tick();
    assert.equal(f.host.querySelector('#plugins-panel-local [data-config-key="COUNT"]').value, '42');
    f.host.querySelector('#plugins-panel-local .plugins-button-primary').click(); await tick();
    assert.equal(f.calls.find(c => c[0] === 'save')[1].revision, 'version1'); controller.dispose();
});

test('settled rows omit redundant markers while runtime facts and exceptional states remain available', async () => {
    const f = fixture();
    const list = f.api.pluginSettingsList;
    f.api.pluginSettingsList = async data => { const result = await list(data); result.data.push({ ...result.data[0], id: 'Second', description: '' }); return result; };
    f.controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local');
    assert.equal(panel.querySelectorAll('.plugins-connection').length, 1);
    assert.equal(panel.querySelector('.plugins-connection').textContent, '节点已连接');
    for (const card of panel.querySelectorAll('.plugins-card')) {
        assert.equal(card.querySelector('.plugins-runtime').hidden, true);
        assert.equal(card.querySelector('.plugins-runtime').textContent, '');
        assert.match(card.querySelector('.plugins-card-expand').getAttribute('aria-label'), /已加载/);
    }
    assert.equal(panel.querySelector('[data-plugin-id="Second"] .plugins-card-description').hidden, true);
    panel.querySelector('.plugins-card-expand').click(); await tick();
    assert.equal(panel.querySelector('.plugins-runtime-fact').textContent, '已加载');
    assert.equal(panel.querySelector(':scope > .plugins-notice').textContent, '');
    assert.equal(runtimeBadge({ category: 'local', enabled: false }).text, '');
    assert.equal(runtimeBadge({ category: 'backend', enabled: true }).text, '');
    assert.equal(runtimeBadge({ category: 'local', enabled: true, runtime: 'loaded', connected: false }).text, '');
    assert.equal(runtimeBadge({ category: 'local', enabled: true, pendingRestart: true }).text, '待重启');
    assert.equal(runtimeBadge({ category: 'local', enabled: true, runtime: 'unloaded' }).text, '未加载');
    assert.equal(runtimeBadge({ category: 'local', error: 'bad manifest' }).tone, 'error');
    assert.equal(runtimeBadge({ category: 'renderer', enabled: true }).text, '状态未知');
    assert.equal(runtimeBadge({ category: 'renderer', enabled: true, name: 'Fixture' }, { getLoadState: () => ({ loaded: false }) }).tone, 'error');
    assert.equal(runtimeLabel({ category: 'renderer', enabled: true, name: 'Fixture' }, { getLoadState: () => ({ loaded: false }) }).text, '加载失败');
    assert.equal(runtimeBadge({ category: 'backend', enabled: true, readOnly: true }).text, '只读');
    f.controller.dispose();
});

test('exception badges stay visible and a disconnected node is reported once at panel level', async () => {
    const f = fixture(); let item = { id: 'Fixture', name: 'Fixture', enabled: true, runtime: 'unloaded', connected: false, category: 'local' };
    f.api.pluginSettingsList = async () => ({ success: true, data: [{ ...item }] });
    f.controller.select('local'); await tick();
    const panel = f.host.querySelector('#plugins-panel-local');
    const badge = panel.querySelector('.plugins-runtime');
    assert.equal(badge.hidden, false); assert.equal(badge.textContent, '未加载');
    assert.equal(panel.querySelector('.plugins-connection').textContent, '节点未连接');
    assert.equal(panel.querySelector('.plugins-connection').dataset.tone, 'pending');
    item.runtime = 'loaded'; item.pendingRestart = true; await f.controller.refresh();
    assert.equal(badge.hidden, false); assert.equal(badge.textContent, '待重启');
    item.pendingRestart = false; item.error = 'Manifest 必须是有效的 JSON 对象'; await f.controller.refresh();
    assert.equal(badge.hidden, false); assert.equal(badge.dataset.tone, 'error');
    assert.equal(panel.querySelector('.plugins-switch').disabled, true);
    item.error = ''; item.readOnly = true; await f.controller.refresh();
    const originalDetail = f.api.pluginSettingsDetail;
    f.api.pluginSettingsDetail = async data => { const result = await originalDetail(data); result.data.readOnly = true; result.data.configSchema = {}; return result; };
    panel.querySelector('.plugins-card-expand').click(); await tick();
    assert.equal(panel.querySelector('.plugins-config-actions').hidden, true);
    assert.equal(panel.querySelector('.plugins-config-fields'), null);
    f.controller.dispose();
});
