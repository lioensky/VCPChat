'use strict';
// 文坊窗口藏着建好、文档载好再显示。
// 改成第一次打开时才建，不在启动后预建。预建省下约 2 秒，代价是从不打开文坊也一直占约 110 MB 私有内存。
// 藏着、没显示过的窗口不算开着的文坊：Agent 请求不发给它（docxHandlers.getHostContents 用 isWarm 跳过）。
// 在文坊窗口里打开时，等页面在 uttu-scriptorium:opened 上回话（preloads/docx.js）；等不到，SHOW_ANYWAY_MS 后照样显示。
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { readOnThreads, listedFiles } = require('../services/moduleFilePrefetch');

// A hidden page is throttled and the 文坊 page waits for two frames while it starts, so it runs unthrottled first.
const AWAKE_MS = 30000;
const SHOW_ANYWAY_MS = 8000;

const openWaiters = new Map();
// ipcMain is missing where tests load docxHandlers with a stand-in electron (tests/scriptorium-library.test.js).
ipcMain?.on?.('uttu-scriptorium:opened', (event, payload) => {
    openWaiters.get(event.sender.id)?.(payload?.ok !== false);
});

// Resolves when the page in contents says the document or folder it was just sent is open (true), failed (false),
// or after SHOW_ANYWAY_MS (false). Call it before sending the request.
function whenOpened(contents, timeoutMs = SHOW_ANYWAY_MS) {
    return new Promise((resolve) => {
        const done = (ok) => {
            clearTimeout(timer);
            if (openWaiters.get(contents.id) === done) openWaiters.delete(contents.id);
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        openWaiters.get(contents.id)?.(false);
        openWaiters.set(contents.id, done);
    });
}

// An unsaved document asks before another one replaces it; the question must be seen, so the window shows first.
async function asksFirst(contents) {
    return contents.executeJavaScript('Boolean(window.UTTUScriptoriumSession?.current?.()?.dirty)').catch(() => false);
}

const warm = new WeakSet();

function isWarm(win) {
    return Boolean(win) && warm.has(win);
}

// docxHandlers.openDocxWindow calls this for every 文坊 window it builds.
function track(win, { warm: hidden = false } = {}) {
    if (!hidden) return;
    warm.add(win);
    win.webContents.setBackgroundThrottling(false);
    const settle = () => {
        if (!win.isDestroyed()) win.webContents.setBackgroundThrottling(true);
    };
    win.once('show', () => { warm.delete(win); settle(); });
    setTimeout(() => { if (warm.has(win)) settle(); }, AWAKE_MS);
}

// 冷盘时最慢：页面一百多个文件逐个过磁盘和杀毒，这台机器一段时间没开过时第一次要 4.9 秒，紧接着再开 2.4 秒。
// 启动后把它们读一遍，读完就扔。记着的是系统的文件缓存，进程不多占内存，和 拿掉的预建窗口不一样。
// 实测冷的时候：没读过就点开要 6.3–8.7 秒，读过再点 2.7–2.9 秒。贵的不只是页面，还有主进程第一次打开时
// 加载的 pdf-lib 这类大文件（文坊窗口建好之前约 1.4 秒），一起读，用后台线程，不占主线程。
async function readAhead(chatRoot, { dir } = {}) {
    const page = path.join(chatRoot, 'ScriptoriumModules', 'scriptorium.html');
    const html = await fs.promises.readFile(page, 'utf8').catch(() => '');
    const files = [...html.matchAll(/(?:src|href)="([^":#]+\.(?:js|css))"/g)].map((match) => path.resolve(path.dirname(page), match[1]));
    files.push(path.join(chatRoot, 'preloads', 'docx.js'), path.join(chatRoot, 'modules', 'ipc', 'docxHandlers.js'));
    files.push(...await listedFiles('scriptorium', { root: chatRoot, dir }));
    const unique = [...new Set(files)];
    const { read, failed } = await readOnThreads(unique);
    return read - failed.size;
}

module.exports = { track, isWarm, whenOpened, asksFirst, readAhead };
