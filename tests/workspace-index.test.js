'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    WorkspaceIndex,
    normalizeWorkspaceList,
    scanWorkspace,
} = require('../modules/services/workspaceIndex');

function writeFile(root, relPath, content = '') {
    const target = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-ws-'));
    writeFile(root, 'modules/inputEnhancer.js', '// a');
    writeFile(root, 'modules/chat/index.js', '// b');
    writeFile(root, 'src/index.js', '// c');
    writeFile(root, 'README.md', '# readme');
    writeFile(root, 'node_modules/pkg/index.js', '// ignored');
    writeFile(root, '.git/HEAD', 'ref');
    writeFile(root, '__pycache__/x.pyc', '');
    writeFile(root, 'myenv/pyvenv.cfg', 'home = x');
    writeFile(root, 'myenv/lib/site.py', '');
    writeFile(root, '.gitignore', 'secret/\n*.log\n');
    writeFile(root, 'secret/key.txt', 'k');
    writeFile(root, 'debug.log', 'l');
    writeFile(root, 'sub/.gitignore', 'local.txt\n');
    writeFile(root, 'sub/local.txt', '');
    writeFile(root, 'sub/keep.txt', '');
    return root;
}

test('scanWorkspace applies default ignores, nested .gitignore and venv detection', async t => {
    const root = createFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const { files, truncated } = await scanWorkspace(root);
    const keys = [...files.keys()].sort();
    assert.equal(truncated, false);
    assert.ok(keys.includes('modules/inputEnhancer.js'));
    assert.ok(keys.includes('sub/keep.txt'));
    assert.ok(keys.includes('.gitignore'));
    for (const excluded of ['node_modules/pkg/index.js', '.git/HEAD', '__pycache__/x.pyc',
        'myenv/lib/site.py', 'secret/key.txt', 'debug.log', 'sub/local.txt']) {
        assert.ok(!keys.includes(excluded), `${excluded} should be ignored`);
    }
});

test('scanWorkspace truncates at maxFiles', async t => {
    const root = createFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { files, truncated } = await scanWorkspace(root, { maxFiles: 2 });
    assert.equal(files.size, 2);
    assert.equal(truncated, true);
});

test('normalizeWorkspaceList dedupes paths and generates unique aliases', () => {
    const list = normalizeWorkspaceList([
        'H:/VCP/VCPChat',
        { path: 'H:/VCP/VCPChat' },
        { path: 'D:/other/VCPChat' },
        { path: 'D:/tool', alias: 'My Tool' },
    ]);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map(item => item.alias), ['vcpchat', 'vcpchat-2', 'my-tool']);
    assert.ok(list.every(item => item.id.startsWith('ws_')));
});

test('search ranks exact file names first and supports alias/path queries', async t => {
    const root = createFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const index = new WorkspaceIndex({ logger: { log() {}, warn() {} }, watch: false });
    t.after(() => index.dispose());
    const [ws] = index.configure([{ path: root, alias: 'demo' }]);

    const exact = await index.search('inputenhancer.js');
    assert.equal(exact[0].relPath, 'modules/inputEnhancer.js');
    assert.equal(exact[0].alias, 'demo');
    assert.equal(exact[0].path, path.join(root, 'modules', 'inputEnhancer.js'));

    const byName = await index.search('index');
    assert.deepEqual(byName.slice(0, 2).map(r => r.relPath).sort(), ['modules/chat/index.js', 'src/index.js']);

    const byPath = await index.search('modules/chat', { alias: 'demo' });
    assert.equal(byPath[0].relPath, 'modules/chat/index.js');

    assert.deepEqual(await index.search('index', { alias: 'missing' }), []);
    assert.equal(index.list()[0].status, 'ready');
    assert.equal(ws.alias, 'demo');
});

test('resolveFile maps absolute paths to the deepest workspace and resolveReference inverts it', async t => {
    const root = createFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const index = new WorkspaceIndex({ logger: { log() {}, warn() {} }, watch: false });
    t.after(() => index.dispose());
    index.configure([{ path: root, alias: 'outer' }, { path: path.join(root, 'modules'), alias: 'inner' }]);

    const target = path.join(root, 'modules', 'chat', 'index.js');
    const resolved = index.resolveFile(`file://${target}`);
    assert.equal(resolved.alias, 'inner');
    assert.equal(resolved.relPath, 'chat/index.js');
    assert.equal(index.resolveReference(resolved), target);

    assert.equal(index.resolveFile(path.join(os.tmpdir(), 'elsewhere.js')), null);
    assert.equal(index.resolveFile(root), null, 'the root itself is not a file reference');
    assert.equal(index.resolveReference({ alias: 'outer', relPath: '../escape.js' }), null);
});

test('rebuild picks up new files when watching is disabled', async t => {
    const root = createFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const index = new WorkspaceIndex({ logger: { log() {}, warn() {} }, watch: false });
    t.after(() => index.dispose());
    index.configure([{ path: root, alias: 'demo' }]);
    await index.search('');
    writeFile(root, 'modules/brandNew.ts', '');
    assert.equal((await index.search('brandnew')).length, 0);
    await index.rebuild();
    assert.equal((await index.search('brandnew'))[0].relPath, 'modules/brandNew.ts');
});