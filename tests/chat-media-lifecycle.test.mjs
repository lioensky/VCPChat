import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { prepareChatMediaHtml, cleanupChatMedia } from '../modules/renderer/mediaLifecycle.js';
import { createImageHandler } from '../modules/renderer/imageHandler.js';

test('media attributes are normalized in an inert template, not escaped code examples', () => {
    const dom = new JSDOM('<body></body>');
    const html = prepareChatMediaHtml(
        '<VIDEO AUTOPLAY="false" LOOP src="clip.mp4"></VIDEO><audio autoplay loop><source src="song.mp3"></audio><pre>\x26lt;audio autoplay loop\x26gt;</pre>',
        dom.window.document,
    );
    const root = dom.window.document.createElement('div');
    root.innerHTML = html;
    for (const media of root.querySelectorAll('audio, video')) {
        assert.equal(media.autoplay, false);
        assert.equal(media.loop, false);
        assert.equal(media.controls, true);
        assert.equal(media.preload, 'metadata');
    }
    assert.equal(root.querySelector('video').getAttribute('src'), 'clip.mp4');
    assert.equal(root.querySelector('source').getAttribute('src'), 'song.mp3');
    assert.equal(root.querySelector('pre').textContent, '<audio autoplay loop>');
    dom.window.close();
});

test('cleanup unloads root media, child sources and stream objects and disposes custom players', () => {
    const dom = new JSDOM('<body><div id="root"><div class="vcp-audio-player"><audio src="song.mp3"><source src="fallback.mp3"></audio></div><video src="clip.mp4"><track src="captions.vtt"></video></div></body>');
    const root = dom.window.document.getElementById('root');
    let disposed = 0;
    root.querySelector('.vcp-audio-player')._vcpAudioCleanup = () => { disposed++; };
    const media = [...root.querySelectorAll('audio, video')];
    for (const node of media) {
        node.srcObject = {};
        node.pause = () => { node.wasPaused = true; };
        node.load = () => { node.wasUnloaded = true; };
    }
    cleanupChatMedia(root);
    assert.equal(disposed, 1);
    cleanupChatMedia(root);
    assert.equal(disposed, 1, 'custom listener cleanup must be released after disposal');
    for (const node of media) {
        assert.equal(node.wasPaused, true);
        assert.equal(node.wasUnloaded, true);
        assert.equal(node.srcObject, null);
        assert.equal(node.hasAttribute('src'), false);
        assert.equal(node.querySelector('[src]'), null);
    }
    media[0].setAttribute('src', 'new.mp3');
    cleanupChatMedia(media[0]);
    assert.equal(media[0].hasAttribute('src'), false, 'individual discarded media is also unloaded');
    dom.window.close();
});

test('content replacement unloads detached media before writing normalized new HTML', () => {
    const dom = new JSDOM('<body><section id="chat"></section></body>');
    const root = dom.window.document.getElementById('chat');
    const handler = createImageHandler();
    handler.initialize({ chatMessagesDiv: root, electronAPI: {} });
    handler.setContentAndProcessImages(root, '<audio src="old.mp3" autoplay loop></audio>', 'm');
    const oldMedia = root.querySelector('audio');
    let pausedWhileConnected = false;
    let unloaded = false;
    oldMedia.pause = () => { pausedWhileConnected = oldMedia.isConnected; };
    oldMedia.load = () => { unloaded = !oldMedia.hasAttribute('src'); };
    handler.setContentAndProcessImages(root, '<video src="new.mp4" autoplay loop></video>', 'm');
    assert.equal(pausedWhileConnected, true);
    assert.equal(unloaded, true);
    assert.equal(oldMedia.isConnected, false);
    assert.equal(root.querySelector('video').autoplay, false);
    assert.equal(root.querySelector('video').loop, false);
    handler.dispose();
    dom.window.close();
});