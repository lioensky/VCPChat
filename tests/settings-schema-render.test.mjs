// M0 试点验收：schema 编译产物与静态标记同构，切换面幂等且不丢现值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { quickActionsSection } from '../modules/settings/schema/quick-actions.js';
import { renderSchemaSection, renderSchemaField } from '../modules/settings/render/field-renderer.js';
import { captureSectionValues, writeFieldValue, readFieldValue } from '../modules/settings/store.js';
import { applySchemaSurface, isSchemaSurfaceEnabled, schemaSurfaceSections } from '../modules/settings/schema-surface.js';
import { mountCanonicalSettingsRows } from '../modules/ui-system/settings/canonical-rows.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;

const doc = dom.window.document;

function renderIntoForm() {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = `section-${quickActionsSection.key}`;
    host.className = 'settings-section';
    host.dataset.settingsSectionKey = quickActionsSection.key;
    form.append(host);
    host.replaceChildren(...renderSchemaSection(quickActionsSection, doc));
    return { form, host };
}

test('quick-actions schema 编译产物保留全部业务锚点与行为标记', () => {
    const { form } = renderIntoForm();
    // 控件 id/name
    for (const key of ['continueWritingPrompt', 'flowlockContinueDelay', 'enableMiddleClickQuickAction',
        'middleClickQuickAction', 'enableRegenerateConfirmation', 'enableMiddleClickAdvanced',
        'middleClickAdvancedDelay']) {
        assert.ok(form.querySelector(`#${key}[name="${key}"]`), `missing control #${key}`);
    }
    // 容器/行锚点（typed-field-owners 按这些 id 直写可见性）
    for (const id of ['middleClickQuickActionContainer', 'regenerateConfirmationContainer',
        'middleClickAdvancedToggleRow', 'middleClickAdvancedSettings']) {
        assert.ok(form.querySelector(`#${id}`), `missing anchored row #${id}`);
    }
    // 依赖子句
    assert.equal(form.querySelector('#middleClickQuickActionContainer').getAttribute('data-visible-when'), 'enableMiddleClickQuickAction');
    assert.equal(form.querySelector('#regenerateConfirmationContainer').getAttribute('data-visible-when'),
        'enableMiddleClickQuickAction && middleClickQuickAction=regenerate');
    assert.equal(form.querySelector('#middleClickAdvancedSettings').getAttribute('data-visible-when'),
        'enableMiddleClickQuickAction && enableMiddleClickAdvanced');
    // textarea 契约
    const textarea = form.querySelector('#continueWritingPrompt');
    assert.equal(textarea.tagName, 'TEXTAREA');
    assert.equal(textarea.getAttribute('placeholder'), '默认: 请继续');
    assert.equal(textarea.getAttribute('rows'), '1');
    assert.equal(textarea.getAttribute('spellcheck'), 'false');
    assert.equal(textarea.textContent, '请继续');
    // number 约束
    const delay = form.querySelector('#flowlockContinueDelay');
    assert.equal(delay.getAttribute('min'), '1');
    assert.equal(delay.getAttribute('max'), '300');
    assert.equal(delay.getAttribute('step'), '1');
    assert.equal(delay.value, '5');
    // select 选项与 hidden
    const select = form.querySelector('#middleClickQuickAction');
    assert.equal(select.hidden, true);
    assert.equal(select.options.length, 9);
    assert.equal(select.options[7].value, 'regenerate');
    assert.equal(select.options[7].textContent, '重新回复');
    // 开关结构
    const advancedToggle = form.querySelector('#enableMiddleClickAdvanced');
    assert.equal(advancedToggle.type, 'checkbox');
    assert.ok(advancedToggle.closest('label.switch'));
    assert.ok(advancedToggle.closest('label.switch').querySelector('span.slider.round'));
    // 分区标题
    assert.equal(form.querySelector('.settings-section-title').textContent, '快捷操作');
});

test('编译产物行形态与静态标记同构（data-vcp-style 与类名）', () => {
    const { form } = renderIntoForm();
    const stackedRow = form.querySelector('#continueWritingPrompt').closest('.vcp-settings-row');
    assert.ok(stackedRow.classList.contains('vcp-settings-row-stacked'));
    assert.equal(stackedRow.getAttribute('data-vcp-style'), '37');
    assert.equal(form.querySelector('#continueWritingPrompt').getAttribute('data-vcp-style'), '38');
    assert.equal(form.querySelector('#flowlockContinueDelay').getAttribute('data-vcp-style'), '19');
    assert.equal(form.querySelector('#flowlockContinueDelay').closest('.vcp-settings-row').getAttribute('data-vcp-style'), '37');
    assert.equal(form.querySelector('#enableMiddleClickQuickAction').closest('.vcp-settings-control-row').getAttribute('data-vcp-style'), '15');
    assert.equal(form.querySelector('#middleClickQuickActionContainer').getAttribute('data-vcp-style'), '34');
    assert.equal(form.querySelector('#middleClickAdvancedSettings').getAttribute('data-vcp-style'), '41');
    assert.equal(form.querySelector('#middleClickAdvancedDelay').getAttribute('data-vcp-style'), '27');
});

test('canonical-rows 对编译产物投影出与静态标记一致的 canonical 行', () => {
    const { form } = renderIntoForm();
    mountCanonicalSettingsRows(form);
    const stackedItem = form.querySelector('#continueWritingPrompt').closest('.vcp-uiux-general-item');
    assert.ok(stackedItem, 'textarea 行应成为 canonical 行');
    assert.ok(stackedItem.classList.contains('vcp-uiux-general-row'));
    assert.ok(stackedItem.classList.contains('vcp-settings-row-stacked'));
    assert.equal(stackedItem.dataset.settingKey, 'continueWritingPrompt');
    assert.equal(stackedItem.dataset.settingsSectionKey, 'quick-actions');
    const copy = stackedItem.querySelector(':scope > .vcp-uiux-row-copy');
    assert.ok(copy, 'textarea 行应有 row-copy 槽');
    assert.equal(copy.querySelector('label').getAttribute('for'), 'continueWritingPrompt');
    assert.ok(copy.querySelector('small'), '提示应进 row-copy 槽');
    // 开关行：label 与 switch 控件分槽
    const switchRow = form.querySelector('#enableMiddleClickQuickAction').closest('.vcp-uiux-general-item');
    assert.ok(switchRow.querySelector(':scope > .vcp-uiux-row-copy label'));
    assert.ok(switchRow.querySelector(':scope > label.switch'));
    // 容器 id 在投影后保留
    assert.ok(form.querySelector('#middleClickQuickActionContainer'), '容器 id 必须穿越投影');
});

test('store 采集与回写：现值迁移不丢失', () => {
    const { form, host } = renderIntoForm();
    form.querySelector('#continueWritingPrompt').value = '自定义提示词';
    form.querySelector('#enableMiddleClickQuickAction').checked = true;
    form.querySelector('#middleClickQuickAction').value = 'regenerate';
    const snapshot = captureSectionValues(form, quickActionsSection);
    // 重新渲染（模拟替换）后回写
    host.replaceChildren(...renderSchemaSection(quickActionsSection, doc));
    assert.equal(form.querySelector('#continueWritingPrompt').value, '请继续', '重渲染后应回到默认值');
    for (const field of quickActionsSection.fields) {
        if (snapshot.has(field.key)) writeFieldValue(form, field, snapshot.get(field.key));
    }
    assert.equal(form.querySelector('#continueWritingPrompt').value, '自定义提示词');
    assert.equal(form.querySelector('#enableMiddleClickQuickAction').checked, true);
    assert.equal(form.querySelector('#middleClickQuickAction').value, 'regenerate');
    assert.equal(readFieldValue(form, quickActionsSection.fields.find(f => f.key === 'enableMiddleClickAdvanced')), false);
});

test('schema-surface：开关关闭为空操作，开启后原地替换且幂等', () => {
    const form = doc.createElement('form');
    const host = doc.createElement('div');
    host.id = 'section-quick-actions';
    host.className = 'settings-section';
    const staticRow = doc.createElement('div');
    staticRow.className = 'vcp-settings-row';
    const staticInput = doc.createElement('input');
    staticInput.id = 'flowlockContinueDelay';
    staticInput.name = 'flowlockContinueDelay';
    staticInput.type = 'number';
    staticInput.value = '42';
    staticRow.append(staticInput);
    host.append(staticRow);
    form.append(host);
    const hostIdentity = host;

    dom.window.localStorage.removeItem('vcpchat-settings-schema');
    assert.equal(isSchemaSurfaceEnabled(), false);
    assert.deepEqual(applySchemaSurface(form, doc), []);

    dom.window.localStorage.setItem('vcpchat-settings-schema', '1');
    assert.ok(schemaSurfaceSections().some(s => s.key === 'quick-actions'));
    const replaced = applySchemaSurface(form, doc);
    assert.deepEqual(replaced, ['quick-actions']);
    assert.equal(host, hostIdentity, '分区元素身份必须保持');
    assert.equal(host.dataset.vcpSchemaRendered, 'true');
    assert.ok(host.querySelector('.settings-section-title'), '渲染后应有标题');
    assert.ok(host.querySelector('#middleClickQuickActionContainer'), '渲染后应有业务容器');
    // 静态标记里已写入的现值（42）必须迁移到渲染产物
    assert.equal(form.querySelector('#flowlockContinueDelay').value, '42');
    // 幂等：重复 refresh 不重渲染（渲染产物中的现值不被默认值覆盖）
    form.querySelector('#flowlockContinueDelay').value = '77';
    assert.deepEqual(applySchemaSurface(form, doc), []);
    assert.equal(form.querySelector('#flowlockContinueDelay').value, '77');
});

test('field-renderer 拒绝未知字段类型', () => {
    assert.throws(() => renderSchemaField(doc, { key: 'x', type: 'mystery', label: 'x' }), /mystery/);
});
