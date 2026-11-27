// 消息图片画图的纯计算（modules/messageImage/renderer/exportMath.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { codePoints, fontCssFor, sliceHeight, snap } from '../modules/messageImage/renderer/exportMath.js';

test('克隆宽度向上取到 1/64 设备像素，不比屏幕窄', () => {
    // 2026-11-27 实测：1.5 倍屏上标签“宽度”排成 56 个设备像素（37.333…px），计算样式字符串只有 "37.3333px"，
    // 截图库按这个值排版，比 56 个设备像素少一丝，图里两个字竖成两行。
    const serialized = Number('37.3333');
    assert.ok(serialized * 1.5 < 56, '原样使用就窄了');
    assert.equal(snap(serialized, 1.5) * 1.5, 56, '取整后正好回到屏幕上的 56 个设备像素');
    for (const zoom of [1, 1.25, 1.5, 2]) {
        const width = snap(serialized, zoom);
        assert.ok(width >= serialized && width - serialized < 1 / (64 * zoom), `zoom ${zoom}`);
        assert.equal(Number.isInteger(Math.round(width * zoom * 64 * 1e6) / 1e6), true);
    }
    assert.equal(snap(46.5, 2), 46.5, '已经对齐的宽度不变');
});

test('长消息分段：每段乘清晰度是整数像素，且不超过画布上限', () => {
    for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
        const css = sliceHeight(scale);
        assert.ok(Number.isInteger(css));
        assert.ok(Math.abs(css * scale - Math.round(css * scale)) < 1e-9, `scale ${scale}`);
        assert.ok(css * scale <= 16000);
        assert.ok(css * scale > 15000);
    }
    assert.equal(sliceHeight(1.5, 997), 664);
});

test('只嵌入消息用得到的字体分片', () => {
    const css = [
        '@font-face { font-family: MiSans; src: url(a.woff2); unicode-range: U+4E00-4E3F; }',
        '@font-face { font-family: MiSans; src: url(b.woff2); unicode-range: U+5000-503F, U+5100; }',
        '@font-face { font-family: MiSans; src: url(c.woff2); unicode-range: U+00??; }',
        '@font-face { font-family: Mono; src: url(d.woff2); }',
    ].join('\n');
    const points = codePoints([{ textContent: '丁' }]); // U+4E01
    const picked = fontCssFor(css, points);
    assert.match(picked, /a\.woff2/);
    assert.doesNotMatch(picked, /b\.woff2/);
    assert.doesNotMatch(picked, /c\.woff2/);
    assert.match(picked, /d\.woff2/, '没写 unicode-range 的字体全区间都算');
    assert.match(fontCssFor(css, codePoints([{ textContent: 'A' }])), /c\.woff2/, '通配符区间');
    assert.match(fontCssFor(css, codePoints([{ textContent: '儀' }])), /b\.woff2/, '逗号分隔的第二段');
});
