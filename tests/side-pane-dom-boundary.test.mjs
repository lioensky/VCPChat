// 侧栏、辅助对话和状态面板不再直接读写别的模块的 DOM：
// 通知状态读 notification-center，主聊天记录变化读 conversation.current，
// 往主输入框填内容、打开轨迹 / V工程 走命令。这里扫源码，防止又绕回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
    'modules/ui-system/side-pane',
    'modules/renderer/side-chat',
    'modules/ui-system/conversation-status-panel.js',
    'modules/renderer/sidePaneWiring.js',
    'modules/renderer/sidePaneCommands.js',
];

const FORBIDDEN = [
    { pattern: /['"`#](notificationsSidebar|vcpLogConnectionStatus|notificationToolbar|notificationsList)\b/, why: '通知面板的元素：读 notification-center 状态' },
    { pattern: /notification-chip-count/, why: '通知计数：读 notification-center 状态' },
    { pattern: /['"`#]chatMessages\b/, why: '主聊天消息区：订阅 conversation.current' },
    { pattern: /['"`#]messageInput\b/, why: '主输入框：用 composer.insert-text 命令' },
    { pattern: /(?:doc|document)\??\.querySelector(?:All)?\([^)]*data-action/, why: '别处的按钮：用命令' },
    { pattern: /\b(?:win|window|ownerWindow)\??\.(?:openModelTrajectory|vcpSidePaneController)\b/, why: 'window 上的全局函数：用命令' },
];

function listFiles(target) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return [target];
    return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(target, entry.name);
        if (entry.isDirectory()) return listFiles(full);
        return /\.(?:js|mjs)$/.test(entry.name) ? [full] : [];
    });
}

test('side pane code reaches other modules through channels and commands, not their DOM', () => {
    const offences = [];
    for (const file of ROOTS.flatMap(listFiles)) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
            for (const { pattern, why } of FORBIDDEN) {
                if (pattern.test(line)) offences.push(`${file.replace(/\\/g, '/')}:${index + 1} ${why}\n    ${line.trim()}`);
            }
        });
    }
    assert.deepEqual(offences, []);
});

test('the main window no longer exposes side pane globals', () => {
    const wiring = fs.readFileSync('modules/renderer/sidePaneWiring.js', 'utf8');
    assert.doesNotMatch(wiring, /win\.(?:openModelTrajectory|vcpSidePaneController)\s*=/);
    for (const file of ['modules/renderer/messageContextMenu.js', 'modules/renderer/contentProcessor.js', 'modules/event-listeners.js']) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\b(?:openModelTrajectory|vcpSidePaneController)\b/, file);
    }
});
