'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fileManager = require('../modules/fileManager');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-live-'));
}

test('isWorkspaceTextFile accepts code/config files and rejects binaries', () => {
    for (const name of ['a.js', 'b.tsx', 'c.py', 'Dockerfile', '.gitignore', 'Makefile', 'x.yaml']) {
        assert.equal(fileManager.isWorkspaceTextFile(name), true, name);
    }
    for (const name of ['a.png', 'b.pdf', 'c.docx', 'd.exe', 'e.zip']) {
        assert.equal(fileManager.isWorkspaceTextFile(name), false, name);
    }
    // 笔记模式仍只接受 .md / .txt
    assert.equal(fileManager.isLiveReferenceCandidate('a.js'), false);
    assert.equal(fileManager.isLiveReferenceCandidate('a.js', { workspace: true }), true);
});

test('createLiveFileReference records workspaceRef and does not copy the file', async t => {
    const root = tempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'src', 'main.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'console.log(1);');

    const att = await fileManager.createLiveFileReference(`file://${file}`, 'main.js', 'application/octet-stream', {
        workspace: { workspaceId: 'ws_1', alias: 'demo', relPath: 'src/main.js' },
    });
    assert.equal(att.isLiveReference, true);
    assert.equal(att.liveSource, 'workspace');
    assert.equal(att.sourcePath, path.resolve(file));
    assert.equal(att.internalPath, `file://${path.resolve(file)}`);
    assert.equal(att.type, 'text/plain');
    assert.equal(att.extractedText, 'console.log(1);');
    assert.deepEqual(att.workspaceRef, { workspaceId: 'ws_1', alias: 'demo', relPath: 'src/main.js' });
    assert.equal(fileManager.describeLiveReference(att), '工作区 demo: src/main.js，实时文件，可直接修改');

    fs.writeFileSync(file, 'console.log(2);');
    assert.equal(await fileManager.readLiveReferenceText(att), 'console.log(2);');
});

test('workspace live references enforce the size limit', async t => {
    const root = tempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'huge.json');
    fs.writeFileSync(file, Buffer.alloc(fileManager.WORKSPACE_LIVE_MAX_BYTES + 1, 0x20));
    await assert.rejects(
        fileManager.createLiveFileReference(file, 'huge.json', 'text/plain', { workspace: { alias: 'demo', relPath: 'huge.json' } }),
        /实时引用上限/,
    );
});

test('readLiveReferenceText re-resolves through the workspace resolver after the root moves', async t => {
    const oldRoot = tempDir();
    const newRoot = tempDir();
    t.after(() => {
        fs.rmSync(oldRoot, { recursive: true, force: true });
        fs.rmSync(newRoot, { recursive: true, force: true });
        fileManager.setWorkspaceReferenceResolver(null);
    });
    fs.writeFileSync(path.join(newRoot, 'app.ts'), 'moved');
    const att = {
        isLiveReference: true,
        liveSource: 'workspace',
        type: 'text/plain',
        sourcePath: path.join(oldRoot, 'app.ts'), // 已不存在
        workspaceRef: { workspaceId: 'ws_1', alias: 'demo', relPath: 'app.ts' },
    };
    fileManager.setWorkspaceReferenceResolver(ref => path.join(newRoot, ...ref.relPath.split('/')));
    assert.equal(await fileManager.readLiveReferenceText(att), 'moved');
});

test('note labels stay unchanged for legacy note references', () => {
    assert.equal(fileManager.describeLiveReference({ isLiveReference: true }), '笔记区实时文件，可直接修改');
});