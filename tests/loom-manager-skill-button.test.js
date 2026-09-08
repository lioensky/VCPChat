'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('LoomSkill 管理按钮位于 LoomAPP 管理器左侧栏底部而非运行应用壳', () => {
    const manager = source('Loommodules/manager.html');
    const shell = source('Loommodules/shell.html');

    assert.match(manager, /<aside class="sidebar">[\s\S]*<div class="app-list" id="appList"><\/div>[\s\S]*<div class="skill-manager-footer">[\s\S]*id="manageSkills"[\s\S]*管理 LoomSkill[\s\S]*<\/aside>/);
    assert.match(manager, /\$\('manageSkills'\)\.addEventListener\('click'/);
    assert.match(manager, /api\.openSkillManager\(\)/);
    assert.doesNotMatch(shell, /id="skills"|open-skill-manager|管理 LoomSkill/);
});

test('LoomAPP 管理器建立可收缩滚动布局并显示左右滚动条', () => {
    const manager = source('Loommodules/manager.html');

    assert.match(manager, /\.layout\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
    assert.match(manager, /\.sidebar\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
    assert.match(manager, /\.app-list\s*\{[\s\S]*?flex:\s*1;[\s\S]*?overflow-y:\s*auto;/);
    assert.match(manager, /\.editor\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
    assert.match(manager, /\.editor-body\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?scrollbar-gutter:\s*stable;/);
    assert.match(manager, /\.editor-body::\-webkit-scrollbar\s*\{[\s\S]*?width:\s*9px;/);
});

test('Loom preload 和管理器主进程提供固定 LoomSkills Canvas 入口', () => {
    const preload = source('preloads/loom.js');
    const loomManager = source('modules/loom/VCPLoomManager.js');

    assert.match(preload, /openSkillManager:\s*\(\)\s*=>\s*invoke\('loom:open-skill-manager'\)/);
    assert.match(loomManager, /path\.join\(this\.appDataRoot,\s*'LoomSkills'\)/);
    assert.match(loomManager, /context:\s*'loom-skill'/);
    assert.match(loomManager, /handle\('loom:open-skill-manager',\s*\(\)\s*=>\s*this\.openSkillManagerInCanvas\(\)\)/);
});

test('Canvas 已打开时切换 rootDir 会刷新完整会话而非保留旧目录文件', () => {
    const canvasHandlers = source('modules/ipc/canvasHandlers.js');

    assert.match(canvasHandlers, /const rootChanged = path\.resolve\(activeRootDir\) !== nextRootDir/);
    assert.match(canvasHandlers, /if \(rootChanged\)\s*\{[\s\S]*?activeCanvasPath = null;/);
    assert.match(canvasHandlers, /await refreshCanvasSession\(canvasWindow\.webContents,\s*filePath\)/);
    assert.match(canvasHandlers, /sender\.send\('canvas-load-data',\s*\{[\s\S]*?session:\s*getSessionPayload\(\)/);
});