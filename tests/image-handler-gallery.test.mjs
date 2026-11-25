import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createImageHandler } from '../modules/renderer/imageHandler.js';

function imagePanel(t, html) {
    const dom = new JSDOM('<main></main><aside></aside>', { url: 'https://example.test/' });
    const { document, MouseEvent } = dom.window;
    const root = document.querySelector('main');
    const message = '<article class="message-item"><div class="md-content"></div></article>';
    root.innerHTML = message;
    document.querySelector('aside').innerHTML = message;
    const calls = [];
    const handler = createImageHandler();
    t.after(() => {
        handler.dispose();
        dom.window.close();
    });
    handler.initialize({ chatMessagesDiv: root, electronAPI: { openImageViewer: payload => calls.push(payload) } });
    handler.setContentAndProcessImages(root.querySelector('.md-content'), html, 'current');
    const images = [...root.querySelectorAll('img')];
    for (const image of images) {
        Object.defineProperties(image, {
            naturalWidth: { value: 160 },
            naturalHeight: { value: Number(image.dataset.height ?? 120) },
        });
    }
    return {
        root, images, document,
        click(image) {
            image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return calls.at(-1);
        },
    };
}

test('gallery takes eligible images in message order from the owning panel only', t => {
    const data = 'data:image/png;base64,AAAA';
    const panel = imagePanel(t, `
        <img class="chat-avatar" src="/avatar.png">
        <img src="/%E8%A1%A8%E6%83%85%E5%8C%85/smile.png">
        <img data-height="16" src="/icon.png">
        <img src="${data}">
        <img src="/fallback.png" alt="Current">
    `);
    const other = panel.document.querySelector('aside .md-content');
    other.innerHTML = '<img src="/another-topic.png">';
    Object.defineProperties(other.firstElementChild, {
        naturalWidth: { value: 160 }, naturalHeight: { value: 120 },
    });
    panel.root.insertAdjacentHTML('afterbegin',
        '<article class="message-item"><div class="md-content"><img src="/earlier.png"></div></article>');
    const earlier = panel.root.querySelector('img');
    Object.defineProperties(earlier, {
        naturalWidth: { value: 160 }, naturalHeight: { value: 120 },
    });
    const [avatar, sticker, icon, embedded, selected] = panel.images;
    Object.defineProperty(selected, 'currentSrc', { value: 'https://example.test/responsive.png' });
    const payload = panel.click(selected);
    assert.deepEqual(payload.gallery, [
        { src: 'https://example.test/earlier.png', title: 'earlier.png' },
        { src: data, title: 'AI 图片' },
        { src: 'https://example.test/responsive.png', title: 'Current' },
    ]);
    assert.equal(payload.index, 2);
    assert.deepEqual(payload.gallery[payload.index], { src: payload.src, title: payload.title });
    assert.equal(panel.click(embedded).title, 'AI 图片');
    embedded.alt = data;
    const embeddedPayload = panel.click(embedded);
    assert.equal(embeddedPayload.title, 'AI 图片');
    assert.equal(embeddedPayload.gallery[embeddedPayload.index].title, 'AI 图片');
    for (const image of [avatar, sticker, icon]) {
        assert.equal(panel.click(image).gallery, undefined);
    }
});

test('gallery caps eligible images at 200 and falls back to the exact clicked image outside the cap', t => {
    const panel = imagePanel(t, '<img data-height="16" src="/icon.png">'
        + Array.from({ length: 201 }, (_, index) => `<img src="/${index}.png">`).join(''));
    const within = panel.click(panel.images[200]);
    assert.equal(within.gallery?.length, 200);
    assert.equal(within.index, 199);
    assert.equal(within.gallery[within.index].src, within.src);
    assert.deepEqual(panel.click(panel.images[201]), {
        src: 'https://example.test/200.png', title: '200.png', theme: 'dark',
    });
});