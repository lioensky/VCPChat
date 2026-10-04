import test from 'node:test';
import assert from 'node:assert/strict';

// 渲染进程的副屏接线只在 Electron 里跑，其他测试大多按文本读它们；这里至少保证整张导入图能被解析，
// 语法错误不会等到窗口白屏才发现
test('side pane renderer wiring modules parse and export their factories', async () => {
    const sidePane = await import('../modules/renderer/sidePaneWiring.js');
    const sideChat = await import('../modules/renderer/sideChatWiring.js');
    const host = await import('../modules/renderer/sidePaneHostBindings.js');
    assert.equal(typeof sidePane.initWorkspaceSidePane, 'function');
    assert.equal(typeof sideChat.createSideChatWiring, 'function');
    assert.equal(typeof host.createSidePaneHostBindings, 'function');
});
