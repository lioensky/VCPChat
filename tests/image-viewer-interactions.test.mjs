import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../modules/image-viewer.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../modules/image-viewer.js', import.meta.url), 'utf8');
async function viewer(t, recognize) {
    const dom = new JSDOM(html, {
        url: 'https://example.test/modules/image-viewer.html?src=sample.png',
        runScripts: 'outside-only'
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} });
    window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
    window.Tesseract = { recognize };
    Object.defineProperty(document.querySelector('#viewerImage'), 'naturalWidth', { value: 800 });
    window.eval(script);
    await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    return document;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('识别保留混排边界、英文词距、缩进和换行', async t => {
    const document = await viewer(t, async () => ({ data: { text: '中 文 A line 40\n\n  Next row' } }));
    document.querySelector('#ocrButton').click();
    await tick();
    assert.equal(document.querySelector('#ocrResultText').value, '中文 A line 40\n  Next row');
});

test('关闭识别结果后，延迟返回的识别结果不重新打开抽屉', async t => {
    let finish;
    const document = await viewer(t, () => new Promise(resolve => { finish = resolve; }));
    document.querySelector('#ocrButton').click();
    await tick();
    const drawer = document.querySelector('#ocrResultModal');
    assert.equal(drawer.style.display, 'block');
    document.querySelector('#ocrModalClose').click();
    finish({ data: { text: 'done' } });
    await tick();
    assert.equal(drawer.style.display, 'none');
});

test('在识别文字框按画笔快捷键，不切换标注工具', async t => {
    const document = await viewer(t, async () => ({ data: { text: 'demo' } }));
    document.querySelector('#ocrResultText').dispatchEvent(new document.defaultView.KeyboardEvent('keydown', {
        key: 'b', bubbles: true
    }));
    assert.equal(document.querySelector('#brushTool').classList.contains('active'), false);
});
async function loadedViewer(t) {
    const document = await viewer(t, async () => ({ data: { text: '' } }));
    const { defaultView: win } = document;
    const image = document.querySelector('#viewerImage');
    Object.defineProperties(image, {
        naturalHeight: { value: 600 }, offsetWidth: { value: 400 }, offsetHeight: { value: 300 }
    });
    image.dispatchEvent(new win.Event('load'));
    const transform = () => document.querySelector('#imageContainer').style.transform;
    const key = key => document.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
    return { document, win, image, transform, key };
}

test('普通滚轮缩放，仍可达到原有的 32 倍上限', async t => {
    const { win, image, transform } = await loadedViewer(t);
    const wheel = () => image.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    wheel();
    assert.match(transform(), /scale\(1\.15\)/);
    for (let i = 0; i < 40; i++) wheel();
    assert.match(transform(), /scale\(32\)/);
});

test('双击在适应窗口与原始尺寸之间切换', async t => {
    const { win, image, transform } = await loadedViewer(t);
    const dblclick = () => image.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    dblclick();
    assert.match(transform(), /scale\(2\)/);
    dblclick();
    assert.match(transform(), /scale\(1\)/);
});

test('看图时 R 旋转，进入标注时回正以保持画布坐标一致', async t => {
    const { document, transform, key } = await loadedViewer(t);
    key('r');
    assert.match(transform(), /rotate\(90deg\)/);
    document.querySelector('#brushTool').click();
    assert.match(transform(), /rotate\(0deg\)/);
    assert.equal(document.querySelector('#drawingCanvas').classList.contains('active'), true);
});