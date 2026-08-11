'use strict';

const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

async function run() {
    await app.whenReady();
    const windowRef = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    try {
        await windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
            '<!doctype html><html><head></head><body></body></html>'
        )}`);
        const moduleSource = fs.readFileSync(
            path.join(
                projectRoot,
                'ScriptoriumModules',
                'scriptorium-export-resources.js'
            ),
            'utf8'
        );
        await windowRef.webContents.executeJavaScript(moduleSource);

        const result = await windowRef.webContents.executeJavaScript(`(async () => {
            const calls = [];
            const imageBytes = Uint8Array.from([137, 80, 78, 71]);
            const audioBytes = Uint8Array.from([73, 68, 51, 3]);
            const readExternalResource = async ({ url }) => {
                calls.push(url);
                if (url === 'http://assets.test/photo.png') {
                    return {
                        success: true,
                        collectable: true,
                        mime: 'image/png',
                        size: imageBytes.byteLength,
                        bytes: imageBytes
                    };
                }
                if (url === 'file:///C:/media/theme.mp3') {
                    return {
                        success: true,
                        collectable: true,
                        mime: 'audio/mpeg',
                        size: audioBytes.byteLength,
                        bytes: audioBytes
                    };
                }
                if (url === 'http://assets.test/not-audio.png') {
                    return {
                        success: true,
                        collectable: true,
                        mime: 'image/png',
                        size: imageBytes.byteLength,
                        bytes: imageBytes
                    };
                }
                throw new Error('不应读取：' + url);
            };
            const bytesToBase64 = (bytes) => {
                let binary = '';
                bytes.forEach((value) => binary += String.fromCharCode(value));
                return btoa(binary);
            };
            const html = \`<!doctype html>
<html lang="zh-CN">
<head><title>便携化测试</title></head>
<body>
    <img id="photo" src="http://assets.test/photo.png">
    <img id="photo-copy" src="http://assets.test/photo.png">
    <picture>
        <source id="responsive" srcset="http://assets.test/photo.png 1x, https://cdn.test/photo@2x.png 2x">
        <img src="https://cdn.test/fallback.png">
    </picture>
    <svg><image id="svg-photo" href="http://assets.test/photo.png"></image></svg>
    <video id="movie" src="http://assets.test/movie.mp4"
        poster="http://assets.test/photo.png"></video>
    <audio id="theme" src="file:///C:/media/theme.mp3"></audio>
    <audio id="mismatch"><source src="http://assets.test/not-audio.png"></audio>
</body>
</html>\`;
            const localized = await window.ScriptoriumExportResources.localizeHtmlMedia(html, {
                readExternalResource,
                bytesToBase64
            });
            const parsed = new DOMParser().parseFromString(localized.html, 'text/html');
            return {
                calls,
                localized,
                values: {
                    photo: parsed.getElementById('photo').getAttribute('src'),
                    photoCopy: parsed.getElementById('photo-copy').getAttribute('src'),
                    responsive: parsed.getElementById('responsive').getAttribute('srcset'),
                    svgPhoto: parsed.getElementById('svg-photo').getAttribute('href'),
                    poster: parsed.getElementById('movie').getAttribute('poster'),
                    video: parsed.getElementById('movie').getAttribute('src'),
                    theme: parsed.getElementById('theme').getAttribute('src'),
                    mismatch: parsed.querySelector('#mismatch source').getAttribute('src')
                }
            };
        })()`);

        assert.deepStrictEqual(result.calls, [
            'http://assets.test/photo.png',
            'file:///C:/media/theme.mp3',
            'http://assets.test/not-audio.png',
        ]);
        assert.strictEqual(result.localized.localized, 2);
        assert.strictEqual(result.localized.localizedReferences, 6);
        assert.strictEqual(result.localized.retained, 1);
        assert.strictEqual(result.localized.failures.length, 1);
        assert.match(result.localized.failures[0].reason, /类型不匹配/);
        assert.match(result.values.photo, /^data:image\/png;base64,/);
        assert.strictEqual(result.values.photoCopy, result.values.photo);
        assert.match(result.values.responsive, /^data:image\/png;base64,[^ ]+ 1x,/);
        assert.match(result.values.responsive, /https:\/\/cdn\.test\/photo@2x\.png 2x$/);
        assert.strictEqual(result.values.svgPhoto, result.values.photo);
        assert.strictEqual(result.values.poster, result.values.photo);
        assert.strictEqual(result.values.video, 'http://assets.test/movie.mp4');
        assert.match(result.values.theme, /^data:audio\/mpeg;base64,/);
        assert.strictEqual(
            result.values.mismatch,
            'http://assets.test/not-audio.png'
        );
        assert.match(result.localized.html, /^<!doctype html>/i);

        console.log('[ScriptoriumExportResources] PASSED');
    } finally {
        if (!windowRef.isDestroyed()) windowRef.destroy();
        app.quit();
    }
}

run().catch((error) => {
    console.error('[ScriptoriumExportResources] FAILED:', error);
    app.exit(1);
});