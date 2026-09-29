'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspaceIndex, renderWorkspaceTreeText } = require('../modules/services/workspaceIndex');
const {
    normalizePromptSettings,
    hasWorkspacePlaceholder,
    expandWorkspacePlaceholders,
} = require('../modules/services/workspacePromptPlaceholders');

const SAMPLE_PATHS = ['modules/inputEnhancer.js', 'modules/chat/index.js', 'src/index.js', 'README.md'];

function writeFile(root, relPath, content = '') {
    const target = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function createIndex(t, alias = 'demo') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-wsp-'));
    for (const relPath of SAMPLE_PATHS) writeFile(root, relPath, '// x');
    writeFile(root, 'node_modules/pkg/index.js', '// ignored');
    const index = new WorkspaceIndex({ logger: { log() {}, warn() {} }, watch: false });
    t.after(() => {
        index.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const [ws] = index.configure([{ path: root, alias }]);
    return { root, index, ws };
}

test('renderWorkspaceTreeText renders dirs before files with indentation', () => {
    const { text, depth, collapsedDirs, omittedLines } = renderWorkspaceTreeText(SAMPLE_PATHS, { maxChars: 10000, maxDepth: 6 });
    assert.equal(text, [
        'modules/',
        '  chat/',
        '    index.js',
        '  inputEnhancer.js',
        'src/',
        '  index.js',
        'README.md',
    ].join('\n'));
    assert.equal(depth, 6);
    assert.equal(collapsedDirs, 0);
    assert.equal(omittedLines, 0);
});

test('renderWorkspaceTreeText lowers depth to fit the budget, then hard-truncates', () => {
    const shallow = renderWorkspaceTreeText(SAMPLE_PATHS, { maxChars: 50, maxDepth: 6 });
    assert.equal(shallow.depth, 1);
    assert.equal(shallow.requestedDepth, 6);
    assert.equal(shallow.collapsedDirs, 2);
    assert.ok(shallow.text.length <= 50);
    assert.match(shallow.text, /^modules\/ \(2 个文件，未展开\)$/m);

    const cut = renderWorkspaceTreeText(SAMPLE_PATHS, { maxChars: 25, maxDepth: 6 });
    assert.equal(cut.text.split('\n').length, 1);
    assert.equal(cut.omittedLines, 2);
});

test('normalizePromptSettings clamps ranges and falls back to defaults', () => {
    assert.deepEqual(normalizePromptSettings(null), { enabled: true, maxChars: 20000, maxDepth: 6 });
    assert.deepEqual(
        normalizePromptSettings({ enabled: false, maxChars: 5, maxDepth: 999 }),
        { enabled: false, maxChars: 1000, maxDepth: 20 }
    );
    assert.deepEqual(
        normalizePromptSettings({ enabled: 'yes', maxChars: 'abc', maxDepth: 3.4 }),
        { enabled: true, maxChars: 20000, maxDepth: 3 }
    );
});

test('hasWorkspacePlaceholder detects both forms only', () => {
    assert.equal(hasWorkspacePlaceholder('a {{VCPChatWorkSpace}} b'), true);
    assert.equal(hasWorkspacePlaceholder('{{VCPChatWorkSpace:vcpchat}}'), true);
    assert.equal(hasWorkspacePlaceholder('{{VCPChatCanvas}}'), false);
    assert.equal(hasWorkspacePlaceholder(null), false);
});

test('expands {{VCPChatWorkSpace:name}} by alias and by folder basename', async t => {
    const { root, index } = createIndex(t);
    const byAlias = await expandWorkspacePlaceholders('前缀\n{{VCPChatWorkSpace:demo}}\n后缀', { index });
    assert.match(byAlias, /^前缀\n\[VCPChat 工作区: demo\]/);
    assert.ok(byAlias.includes(`根目录: ${root}`));
    assert.ok(byAlias.includes('已索引文件数: 4'));
    assert.ok(byAlias.includes('  inputEnhancer.js'));
    assert.ok(!byAlias.includes('node_modules/'), '默认忽略目录不应出现在目录树中');
    assert.ok(byAlias.endsWith('[/VCPChat 工作区: demo]\n后缀'));

    const byFolder = await expandWorkspacePlaceholders(`{{VCPChatWorkSpace:${path.basename(root).toUpperCase()}}}`, { index });
    assert.match(byFolder, /^\[VCPChat 工作区: demo\]/);
});

test('bare {{VCPChatWorkSpace}} uses the active workspace or explains its absence', async t => {
    const { index, ws } = createIndex(t);
    const withActive = await expandWorkspacePlaceholders('{{VCPChatWorkSpace}}', { index, activeWorkspaceId: ws.id });
    assert.match(withActive, /^\[VCPChat 工作区: demo\]/);

    const withoutActive = await expandWorkspacePlaceholders('{{VCPChatWorkSpace}}', { index });
    assert.match(withoutActive, /当前未选择工作区/);
});

test('unknown names, disabled setting, duplicates and missing index', async t => {
    const { index } = createIndex(t);
    assert.equal(
        await expandWorkspacePlaceholders('{{VCPChatWorkSpace:nope}}', { index }),
        '[VCPChat 工作区 "nope" 未登记或已停用]'
    );

    const raw = 'x {{VCPChatWorkSpace:demo}}';
    assert.equal(await expandWorkspacePlaceholders(raw, { index, settings: { enabled: false } }), raw);

    const twice = await expandWorkspacePlaceholders('{{VCPChatWorkSpace:demo}}\n{{VCPChatWorkSpace: demo }}', { index });
    assert.equal(twice.split('[VCPChat 工作区: demo]').length - 1, 2);

    assert.equal(await expandWorkspacePlaceholders('{{VCPChatWorkSpace:demo}}', { index: null }), '[VCPChat 工作区服务未就绪]');
    assert.equal(await expandWorkspacePlaceholders('no placeholder', { index }), 'no placeholder');
});