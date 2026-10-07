'use strict';

// 侧栏终端「跳转到工作区」打到共享终端里的命令
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle() {}, removeHandler() {}, on() {} }, BrowserWindow: class {}, clipboard: {}, shell: {} };
    return originalLoad.call(this, request, parent, isMain);
};
const { buildChangeDirectoryCommand } = require('../modules/ipc/terminalHandlers');
Module._load = originalLoad;

test('the jump command is typed but not submitted', () => {
    // 前台可能是 vim / python / 密码提示：不替用户按回车
    for (const platform of ['win32', 'linux', 'darwin']) {
        assert.doesNotMatch(buildChangeDirectoryCommand('/w', platform), /[\r\n]$/);
    }
});

test('PowerShell quoting doubles typographic single quotes too', () => {
    // PowerShell 把 ‘ ’ ‚ ‛ 当单引号；不转义的话目录名能提前结束字符串，后面的部分会被当成命令执行
    const dir = 'D:\\a\u2019; calc; \u2018b';
    assert.equal(buildChangeDirectoryCommand(dir, 'win32'), "Set-Location -LiteralPath 'D:\\a\u2019\u2019; calc; \u2018\u2018b'");
    assert.equal(buildChangeDirectoryCommand("D:\\Tom's \u201Aapp\u201B", 'win32'), "Set-Location -LiteralPath 'D:\\Tom''s \u201A\u201Aapp\u201B\u201B'");
    assert.equal(buildChangeDirectoryCommand("/home/tom's", 'linux'), "cd '/home/tom'\\''s'");
});
