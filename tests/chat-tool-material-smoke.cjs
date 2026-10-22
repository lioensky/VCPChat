'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tool-material-'));
app.setPath('userData', temp);
app.on('window-all-closed', () => {});
let win;
const timeout = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '..');
    const styles = ['styles/themes.css', 'styles/messageRenderer.css', 'styles/ui-system/tool-presentation.css']
        .map(file => `<style>${fs.readFileSync(path.join(root, file), 'utf8')}</style>`).join('');
    const request = `<div class="vcp-tool-use-bubble"><div class="vcp-tool-summary"><span class="vcp-tool-label">VCP-ToolUse:</span><span class="vcp-tool-name-highlight">${'LongToolName'.repeat(30)}</span></div><div class="vcp-tool-details"><pre>details</pre></div></div>`;
    const result = `<div class="vcp-tool-result-bubble"><div class="vcp-tool-result-header"><span class="vcp-tool-result-label">VCP-ToolResult</span><span class="vcp-tool-result-name">ProjectForge</span><span class="vcp-tool-result-status status-success">SUCCESS</span></div><div class="vcp-tool-result-collapsible-content">result</div></div>`;
    const summary = '<div class="vcp-tool-call-summary-bubble"><div class="vcp-tool-call-summary-header"><span class="vcp-tool-call-summary-icon">🧾</span><span class="vcp-tool-call-summary-title">本轮工具调用摘要</span></div><div class="vcp-tool-call-summary-list"><span class="vcp-tool-call-summary-chip"><span class="vcp-tool-call-summary-tool">ProjectForge</span><span class="vcp-tool-call-summary-status">成功</span></span></div></div>';
    const html = `<html data-ui-mode="next"><head>${styles}</head><body data-vcp-theme="dark"><div class="vcp-ui-scope"><article class="message-item"><div class="md-content" style="width:320px">${request}${result}${summary}<div class="vcp-role-divider"><span class="divider-text">Assistant</span></div></div></article><div data-vcp-tool-presentation="compact"><div class="vcp-tool-use-bubble vcp-tool-presented">开发视图</div></div></div></body></html>`;
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const samples = await win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.md-content > :is(.vcp-tool-use-bubble,.vcp-tool-result-bubble,.vcp-tool-call-summary-bubble)')];
        function sample(light) {
            document.body.classList.toggle('light-theme', light);
            document.body.dataset.vcpTheme = light ? 'light' : 'dark';
            const states = cards.map(el => {
                const s = getComputedStyle(el);
                return { background: s.backgroundColor, animation: s.animationName, blur: s.backdropFilter,
                    layer: s.willChange, left: s.borderLeftWidth, overflow: el.getBoundingClientRect().width > 321 };
            });
            const typography = cards.map(el => {
                const title = getComputedStyle(el.querySelector('.vcp-tool-name-highlight, .vcp-tool-result-name, .vcp-tool-call-summary-title'));
                const icon = getComputedStyle(el, '::before');
                return { font: title.fontFamily, size: title.fontSize, weight: title.fontWeight,
                    padding: getComputedStyle(el).paddingLeft, icon: icon.maskImage,
                    iconSize: icon.width, content: icon.content };
            });
            const meta = [...document.querySelectorAll('.vcp-tool-label,.vcp-tool-result-label,.vcp-tool-result-status,.vcp-tool-call-summary-status')].map(el => getComputedStyle(el).fontSize);
            const role = getComputedStyle(document.querySelector('.divider-text'));
            const dev = getComputedStyle(document.querySelector('.vcp-tool-presented'));
            return { states, typography, meta, dpr: window.devicePixelRatio, roleBorder: role.borderTopWidth, devBorder: dev.borderLeftWidth };
        }
        return [sample(false), sample(true)];
    })()`);
    for (const mode of samples) {
        for (const card of mode.states) {
            assert.equal(card.animation, 'none');
            assert.equal(card.blur, 'none');
            assert.equal(card.layer, 'auto');
            assert.ok(Math.abs(parseFloat(card.left) - 3) < 1 / mode.dpr + 0.01, `3px border rasterization: ${card.left} at DPR ${mode.dpr}`);
            assert.equal(card.overflow, false);
            assert.notEqual(card.background, 'rgba(0, 0, 0, 0)');
        }
        for (const title of mode.typography) {
            assert.equal(title.font, mode.typography[0].font);
            assert.equal(title.size, '13px');
            assert.equal(title.weight, '600');
            assert.equal(title.padding, '36px');
            assert.equal(title.iconSize, '16px');
            assert.match(title.icon, /data:image\/svg/);
            assert.equal(title.content, '""');
        }
        assert.ok(mode.meta.every(size => size === '12px'), JSON.stringify(mode.meta));
        assert.equal(mode.roleBorder, '0px');
        assert.equal(mode.devBorder, '0px');
    }
    assert.notEqual(samples[0].states[0].background, samples[1].states[0].background);
    assert.equal(fs.existsSync(path.join(root, 'modules/renderer/decorativeAnimationGate.js')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'modules/messageRenderer.js'), 'utf8'), /decorativeAnimationGate/);
    console.log('CHAT_TOOL_MATERIAL_PASS', JSON.stringify(samples));
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
}).catch(error => {
    console.error(error);
    clearTimeout(timeout);
    win?.destroy();
    app.exit(1);
});