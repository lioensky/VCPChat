import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const load = async path => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path, 'utf8')).toString('base64'));
const { createToolPresentation, resolveToolPresentationProfile } = await load('modules/renderer/toolPresentation.js');
const schema = await load('modules/settings/schema/sidebar-surfaces.js');

test('each local field independently inherits; invalid values fail back to global without mutation', () => {
    const global = { toolPresentation: 'grouped', toolExpansion: 'attention', density: 'compact' };
    for (const local of [{}, { toolPresentation: 'inherit', toolExpansion: 'inherit' }, { toolPresentation: 'garbage', toolExpansion: 'garbage' }]) {
        assert.deepEqual(resolveToolPresentationProfile(global, local), global);
    }
    assert.deepEqual(resolveToolPresentationProfile(global, { toolPresentation: 'legacy' }), { ...global, toolPresentation: 'legacy' });
    assert.deepEqual(resolveToolPresentationProfile(global, { toolExpansion: 'none' }), { ...global, toolExpansion: 'none' });
    assert.equal(global.toolPresentation, 'grouped');
});

test('owner override survives preview; inherited fields use event payload; save refresh and disposal work', () => {
    const dom = new JSDOM('<html data-ui-mode="next"><body><div id="a"><div class="md-content"></div></div><div id="b"><div class="md-content"></div></div></body></html>');
    const win = dom.window, doc = win.document;
    const html = '<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use"><div class="vcp-tool-summary">Tool</div><div class="vcp-tool-details"></div><template class="vcp-tool-details-template"><pre>tool_name:「始」ProjectForge「末」</pre></template></div>';
    const local = { toolPresentation: 'compact', toolExpansion: 'inherit' };
    const global = { toolPresentation: 'legacy', toolExpansion: 'attention' };
    const a = doc.querySelector('#a'), b = doc.querySelector('#b');
    a.firstChild.innerHTML = b.firstChild.innerHTML = html;
    const pa = createToolPresentation({ root: a, getProfile: () => global, getLocalConfig: () => local });
    const pb = createToolPresentation({ root: b, getProfile: () => global, getLocalConfig: () => ({}) });
    pa.apply(a.firstChild); pb.apply(b.firstChild);
    assert.equal(a.firstChild.dataset.vcpToolPresentation, 'compact');
    assert.equal(b.firstChild.dataset.vcpToolPresentation, 'legacy');
    win.dispatchEvent(new win.CustomEvent('vcp-appearance-changed', { detail: { profile: { toolPresentation: 'grouped', toolExpansion: 'all' } } }));
    assert.equal(a.firstChild.dataset.vcpToolPresentation, 'compact');
    assert.ok(a.querySelector('.vcp-tool-use-bubble').classList.contains('expanded'));
    assert.equal(b.firstChild.dataset.vcpToolPresentation, 'grouped');
    local.toolPresentation = 'legacy';
    win.dispatchEvent(new win.CustomEvent('vcp-tool-presentation-changed'));
    assert.equal(a.firstChild.dataset.vcpToolPresentation, 'legacy');
    local.toolPresentation = 'inherit';
    global.toolPresentation = 'inline';
    win.dispatchEvent(new win.CustomEvent('vcp-tool-presentation-changed'));
    assert.equal(a.firstChild.dataset.vcpToolPresentation, 'inline');
    pa.dispose(); pb.dispose();
    global.toolPresentation = 'process';
    win.dispatchEvent(new win.CustomEvent('vcp-tool-presentation-changed'));
    assert.equal(a.firstChild.dataset.vcpToolPresentation, 'inline');
    win.close();
});

test('Agent and Group style controls expose inheritance and all existing modes', () => {
    const dom = new JSDOM('<div id="agent"></div><div id="group"></div>');
    const doc = dom.window.document;
    schema.renderAgentSettingsSurface(doc.querySelector('#agent'), doc);
    schema.renderGroupSettingsSurface(doc.querySelector('#group'), doc);
    for (const kind of ['agent', 'group']) {
        const style = doc.getElementById(`${kind}ToolPresentation`);
        const expansion = doc.getElementById(`${kind}ToolExpansion`);
        assert.equal(style.value, 'inherit');
        assert.equal(expansion.value, 'inherit');
        assert.deepEqual([...style.options].map(o => o.value), ['inherit', 'legacy', 'compact', 'grouped', 'inline', 'process']);
        assert.deepEqual([...expansion.options].map(o => o.value), ['inherit', 'attention', 'none', 'all']);
        assert.equal(schema.getSchemaField(kind, style.id).name, 'toolPresentation');
    }
    dom.window.close();
});