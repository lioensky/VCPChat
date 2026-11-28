// 音乐窗口里的开关、滑块、图标按钮都要有读屏能念出来的名字。
// 声音页的开关旁边那行字是标题（h4）或没有 for 的 <label>，读屏只念「复选框，未选中」，分不清是哪一个。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('Musicmodules/music.html', 'utf8');

test('every switch, slider, select and icon button in music.html has a name', () => {
    const { document } = new JSDOM(html).window;
    const missing = [];
    for (const el of document.querySelectorAll('input:not([type="hidden"]), select, button, [role="slider"]')) {
        // 底栏开着时旧的那排播放键整个藏起来，不算
        if (el.closest('.music-player .controls, [aria-hidden="true"]')) continue;
        const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
            || [...(el.labels || [])].map((l) => l.textContent.trim()).join('')
            || el.textContent.trim() || el.getAttribute('title') || el.getAttribute('placeholder');
        if (!String(name || '').trim()) missing.push(el.id || el.outerHTML.slice(0, 60));
    }
    assert.deepEqual(missing, []);
});
