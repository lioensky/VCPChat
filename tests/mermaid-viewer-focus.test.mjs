import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../modules/messageRenderer.js', import.meta.url), 'utf8');
const start = source.indexOf('function enhanceMermaidDiagram(');
const end = source.indexOf('\nfunction getCompiledRegex(', start);
const { enhanceMermaidDiagram: enhance, cleanupMermaidViewers: cleanup } = new Function(
    `${source.slice(start, end)}; return { enhanceMermaidDiagram, cleanupMermaidViewers };`
)();

test('the wheel scrolls the chat until a diagram is clicked; outside click, Esc and focus moves release it', () => {
    const dom = new JSDOM('<main><div class="mermaid"><svg></svg></div>'
        + '<div class="mermaid"><svg></svg></div><p>正文</p><input></main>');
    const { document, MouseEvent, WheelEvent, KeyboardEvent } = dom.window;
    try {
        document.querySelectorAll('.mermaid').forEach(enhance);
        const [first, second] = document.querySelectorAll('.mermaid-viewer-viewport');
        const scale = viewport => viewport.closest('.mermaid-viewer').dataset.scale;
        let bubbled = 0;
        document.addEventListener('wheel', () => bubbled++);
        const wheel = (viewport, deltaY = -100) => {
            const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
            viewport.dispatchEvent(event);
            return event;
        };
        const pointer = target => {
            target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
            target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
        };

        // 未点中：滚轮照常冒泡给聊天区，图表不缩放。
        assert.equal(wheel(first).defaultPrevented, false);
        assert.equal(scale(first), '1');
        assert.equal(bubbled, 1);

        // 点中后滚轮缩放，且不再滚动聊天区。
        pointer(first.querySelector('svg'));
        assert.equal(document.activeElement, first);
        assert.equal(wheel(first).defaultPrevented, true);
        assert.ok(Number(scale(first)) > 1);
        assert.equal(bubbled, 1);

        // 纯横向滚轮帧不改变缩放。
        const zoomed = scale(first);
        assert.equal(wheel(first, 0).defaultPrevented, false);
        assert.equal(scale(first), zoomed);

        // 点别处释放。
        pointer(document.querySelector('p'));
        assert.notEqual(document.activeElement, first);
        assert.equal(wheel(first).defaultPrevented, false);

        // Esc 释放。
        pointer(first);
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(wheel(first).defaultPrevented, false);

        // 点另一张图，只有那一张接管滚轮。
        pointer(first);
        pointer(second);
        assert.equal(document.activeElement, second);
        assert.equal(wheel(first).defaultPrevented, false);
        assert.equal(wheel(second).defaultPrevented, true);

        // 焦点移到输入框后释放。
        document.querySelector('input').focus();
        assert.equal(wheel(second).defaultPrevented, false);

        // 工具栏按钮照常可用，且不会让图表接管之后的滚轮。
        first.closest('.mermaid-viewer').querySelector('[data-mermaid-action="zoom-in"]').click();
        assert.ok(Number(scale(first)) > Number(zoomed));
        assert.equal(wheel(first).defaultPrevented, false);

        // 清理后文档级监听一并移除。
        const wrapper = first.closest('.mermaid-viewer');
        cleanup(document.querySelector('main'));
        assert.equal(wrapper._vcpDisposers.length, 0);
        assert.equal(wheel(first).defaultPrevented, false);
    } finally {
        dom.window.close();
    }
});
