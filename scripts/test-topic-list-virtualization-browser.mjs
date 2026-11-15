import fs from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let css = '@layer vcp-ui.legacy,vcp-ui.components;';
    for (const path of [
        'styles/layout.css',
        'styles/setting/settings-sidebar-tabs.css',
        'styles/setting/settings-sidebar-list.css'
    ]) css += `@layer vcp-ui.legacy { ${fs.readFileSync(path, 'utf8')} }`;
    css += fs.readFileSync('styles/ui-system/sidebar.css', 'utf8');
    css += fs.readFileSync('styles/compact-sidebar.css', 'utf8');
    css += fs.readFileSync('styles/ui-system/settings-sidebar.css', 'utf8');
    await page.setContent(`<style>${css}</style>
        <aside class="sidebar active vcp-ui-scope" style="height:600px;transition:none">
            <section id="tabContentAgents" class="sidebar-tab-content"><div>Agents</div></section>
            <section id="tabContentTopics" class="sidebar-tab-content active">
                <div class="sidebar-list-scroll"><ul id="topicList" class="topic-list"></ul></div>
            </section>
            <section id="tabContentSettings" class="sidebar-tab-content"><div>Settings</div></section>
        </aside>`);
    await page.addScriptTag({ content: fs.readFileSync('vendor/Sortable.min.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('modules/topicListManager.js', 'utf8') });
    const result = await page.evaluate(async () => {
        let configCalls = 0;
        let historyCalls = 0;
        let concurrent = 0;
        let peakConcurrent = 0;
        const topics = Array.from({ length: 10000 }, (_, i) => ({ id: `t${i}`, name: `Topic ${i}` }));
        window.topicListManager.init({
            elements: { topicListContainer: document.getElementById('tabContentTopics') },
            electronAPI: { getAgentConfig: async () => { configCalls++; return { id: 'mock', topics }; } },
            chatRepository: {
                getHistory: async () => {
                    historyCalls++;
                    peakConcurrent = Math.max(peakConcurrent, ++concurrent);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    concurrent--;
                    return [];
                }
            },
            refs: {
                currentSelectedItemRef: { get: () => ({ id: 'mock', type: 'agent', name: 'Mock' }) },
                currentTopicIdRef: { get: () => 't0' }
            },
            uiHelper: {},
            mainRendererFunctions: { updateCurrentItemConfig() {} },
            topicSelectionReadiness: { isReady: () => true, defer() {} }
        });
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const wait = async () => { await frames(); await frames(); };
        const panel = document.getElementById('tabContentTopics');
        const sidebar = document.querySelector('.sidebar');
        const scroller = document.querySelector('#tabContentTopics .sidebar-list-scroll');
        const rows = () => [...document.querySelectorAll('.topic-item')];
        const sample = () => ({
            rows: rows().length,
            boxes: rows().filter(row => row.getClientRects().length).length,
            first: rows()[0]?.dataset.topicId,
            last: rows().at(-1)?.dataset.topicId,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            panelDisplay: getComputedStyle(panel).display
        });
        await window.topicListManager.loadTopicList();
        await wait();
        const initial = sample();
        let maxMounted = initial.rows;
        for (let i = 1; i <= 20; i++) {
            scroller.scrollTop = i * 18000;
            scroller.dispatchEvent(new Event('scroll'));
            await wait();
            maxMounted = Math.max(maxMounted, rows().length);
        }
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll'));
        await wait();
        const bottom = sample();
        panel.classList.remove('active');
        document.getElementById('tabContentAgents').classList.add('active');
        window.topicListManager.syncSurfaceVisibility();
        await wait();
        const hidden = sample();
        sidebar.style.width = '180px';
        await wait();
        const hiddenNarrow = sample();
        panel.classList.add('active');
        document.getElementById('tabContentAgents').classList.remove('active');
        window.topicListManager.syncSurfaceVisibility();
        await wait();
        const restored = sample();
        sidebar.style.setProperty('--vcp-ui-sidebar-row-height', '48px');
        await wait();
        const resized = sample();
        const row = rows()[0];
        const rowStyle = getComputedStyle(row);
        const stride = parseFloat(rowStyle.height) + parseFloat(rowStyle.marginBottom);
        const expectedTotal = topics.length * stride;
        const actualTotal = scroller.querySelector('.topic-list').getBoundingClientRect().height;
        panel.classList.remove('active');
        sidebar.classList.add('avatar-only');
        document.getElementById('tabContentAgents').classList.add('active');
        window.topicListManager.syncSurfaceVisibility();
        await wait();
        panel.classList.add('compact-drawer-open');
        window.topicListManager.syncSurfaceVisibility();
        await wait();
        const drawer = sample();
        panel.classList.remove('compact-drawer-open');
        window.topicListManager.syncSurfaceVisibility();
        await wait();
        const closedDrawer = sample();
        window.topicListManager.dispose();
        return {
            initial, maxMounted, bottom, hidden, hiddenNarrow, restored,
            resized, expectedTotal, actualTotal, drawer, closedDrawer,
            configCalls, historyCalls, peakConcurrent
        };
    });
    assert.ok(result.maxMounted <= 40, 'mount count is bounded independently of 10000 topics');
    assert.equal(result.bottom.last, 't9999');
    assert.equal(result.hidden.rows, 0);
    assert.equal(result.hidden.boxes, 0);
    assert.equal(result.hidden.panelDisplay, 'none');
    assert.equal(result.hiddenNarrow.rows, 0);
    assert.equal(result.restored.scrollTop, result.bottom.scrollTop);
    assert.equal(result.restored.last, 't9999');
    assert.ok(Math.abs(result.expectedTotal - result.actualTotal) <= 2, 'spacers match the current row height');
    assert.ok(result.drawer.rows > 0);
    assert.equal(result.drawer.panelDisplay, 'flex');
    assert.equal(result.closedDrawer.rows, 0);
    assert.equal(result.configCalls, 1, 'surface toggles restore snapshots without rereading config');
    assert.ok(result.peakConcurrent <= 4);
    const motion = await page.evaluate(() => {
        const sidebar = document.querySelector('.sidebar');
        sidebar.classList.remove('avatar-only');
        const panels = [...sidebar.querySelectorAll('.sidebar-tab-content')];
        return ['tabContentAgents', 'tabContentTopics', 'tabContentSettings', 'tabContentAgents'].map(id => {
            panels.forEach(panel => panel.classList.remove('active'));
            panels.forEach(panel => getComputedStyle(panel).display);
            const panel = document.getElementById(id);
            panel.classList.add('active');
            const animation = panel.getAnimations().find(item => item.animationName === 'sidebarTabEnter');
            if (!animation) return { id, missing: true };
            animation.pause();
            animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
            const style = getComputedStyle(panel);
            const middleOpacity = Number(style.opacity);
            const properties = Object.keys(animation.effect.getKeyframes()[0])
                .filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key));
            animation.finish();
            return {
                id, middleOpacity, properties,
                finalOpacity: Number(getComputedStyle(panel).opacity),
                hiddenBoxes: panels.filter(other => other !== panel)
                    .reduce((sum, other) => sum + other.getClientRects().length, 0)
            };
        });
    });
    for (const sample of motion) {
        assert.equal(sample.missing, undefined, `${sample.id} must start its entry animation`);
        assert.ok(sample.middleOpacity > 0 && sample.middleOpacity < 1, 'the animation visibly interpolates opacity');
        assert.equal(sample.finalOpacity, 1);
        assert.equal(sample.hiddenBoxes, 0, 'animation must not keep outgoing panels in layout');
        assert.deepEqual(sample.properties.sort(), ['opacity', 'transform']);
    }
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const reduced = await page.evaluate(() => {
        const panels = [...document.querySelectorAll('.sidebar-tab-content')];
        return panels.map(panel => {
            panels.forEach(other => other.classList.remove('active'));
            panel.classList.add('active');
            return getComputedStyle(panel).animationName;
        });
    });
    assert.ok(reduced.every(name => name === 'none'), 'reduced motion disables tab entry animations');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ...result, motion, reduced }, null, 2));
    console.log('Topic list browser layout and sidebar tab motion assertions passed.');
} finally {
    await browser.close();
}