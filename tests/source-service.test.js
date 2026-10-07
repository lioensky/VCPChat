'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sourceService = require('../modules/services/sourceService');

function makeWorkspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (rel, content) => {
        const abs = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        return abs;
    };
    return { root, write };
}

test('listFiles walks the workspace, skips ignored directories and sorts paths', async t => {
    const { root, write } = makeWorkspace(t);
    write('src/app.js', 'a');
    write('src/lib/util.ts', 'b');
    write('README.md', 'c');
    write('node_modules/pkg/index.js', 'x');
    write('.git/HEAD', 'ref');
    const result = await sourceService.listFiles(root);
    assert.deepEqual(result.files, ['README.md', 'src/app.js', 'src/lib/util.ts']);
    assert.equal(result.truncated, false);

    const limited = await sourceService.listFiles(root, { limit: 2 });
    assert.equal(limited.files.length, 2);
    assert.equal(limited.truncated, true);
});

test('resolveWorkspacePath rejects escapes, absolute paths and .git', t => {
    const { root } = makeWorkspace(t);
    assert.equal(sourceService.resolveWorkspacePath(root, 'src\\a.js').rel, 'src/a.js');
    assert.throws(() => sourceService.resolveWorkspacePath(root, '../outside.txt'), /不在工作区内/);
    assert.throws(() => sourceService.resolveWorkspacePath(root, 'a/../../x'), /不在工作区内/);
    assert.throws(() => sourceService.resolveWorkspacePath(root, '/etc/passwd'), /相对路径/);
    assert.throws(() => sourceService.resolveWorkspacePath(root, 'C:/Windows/win.ini'), /相对路径/);
    assert.throws(() => sourceService.resolveWorkspacePath(root, '.git/config'), /\.git/);
    assert.throws(() => sourceService.resolveWorkspacePath(root, ''), /无效/);
    assert.throws(() => sourceService.resolveWorkspacePath(root, '.'), /不在工作区内/);
});

test('resolveWorkspacePath rejects NTFS aliases of .git and symlinks into .git', async t => {
    const { root, write } = makeWorkspace(t);
    write('.git/config', '[core]\n');
    write('src/app.js', 'a');
    // Windows 上这些名字都指向 .git：短名、末尾点/空格、流名
    for (const rel of ['GIT~1/config', 'git~2/config', '.git./config', '.git ./config', '.git::$INDEX_ALLOCATION/config', 'src/../.GIT/config']) {
        assert.throws(() => sourceService.resolveWorkspacePath(root, rel), /\.git/, rel);
    }
    // 工作区里的符号链接指向 .git：名字上看不出来，写进去就能改 core.fsmonitor 等配置
    fs.symlinkSync(path.join(root, '.git'), path.join(root, 'meta'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => sourceService.resolveWorkspacePath(root, 'meta/config'), /\.git/);
    await assert.rejects(sourceService.writeFile(root, 'meta/config', { content: '[core]\n\tfsmonitor = evil\n', force: true }), /\.git/);
    assert.equal(fs.readFileSync(path.join(root, '.git/config'), 'utf8'), '[core]\n');
    // 普通名字不受影响
    assert.equal(sourceService.resolveWorkspacePath(root, 'src/app.js').rel, 'src/app.js');
    assert.equal(sourceService.resolveWorkspacePath(root, '.github/workflows/ci.yml').rel, '.github/workflows/ci.yml');
    assert.equal(sourceService.resolveWorkspacePath(root, 'git~notes.md').rel, 'git~notes.md');
});

test('readFile reports BOM / EOL, binary and invalid UTF-8', async t => {
    const { root, write } = makeWorkspace(t);
    write('crlf.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
    write('bin.dat', Buffer.from([1, 2, 0, 3]));
    write('latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    write('conf.json', '{}');

    const crlf = await sourceService.readFile(root, 'crlf.txt');
    assert.equal(crlf.bom, true);
    assert.equal(crlf.eol, '\r\n');
    assert.equal(crlf.text, 'a\r\nb\r\n');
    assert.equal(crlf.editable, true);

    const bin = await sourceService.readFile(root, 'bin.dat');
    assert.equal(bin.binary, true);
    assert.equal(bin.editable, false);

    const latin = await sourceService.readFile(root, 'latin.txt');
    assert.equal(latin.encodingError, true);
    assert.equal(latin.editable, false);

    assert.equal((await sourceService.readFile(root, 'conf.json')).checkLanguage, 'JSON');
    await assert.rejects(sourceService.readFile(root, 'missing.txt'), /不存在/);
});

test('writeFile keeps BOM and EOL, detects conflicts and honours force', async t => {
    const { root, write } = makeWorkspace(t);
    const abs = write('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]));
    const opened = await sourceService.readFile(root, 'a.txt');

    const saved = await sourceService.writeFile(root, 'a.txt', { content: 'one\ntwo\nthree\n', expectedHash: opened.hash });
    assert.equal(saved.changed, true);
    const disk = fs.readFileSync(abs);
    assert.deepEqual([...disk.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(disk.subarray(3).toString('utf8'), 'one\r\ntwo\r\nthree\r\n');

    // 使用过期哈希 → 冲突
    await assert.rejects(
        sourceService.writeFile(root, 'a.txt', { content: 'x', expectedHash: opened.hash }),
        error => error.code === 'CONFLICT',
    );
    const forced = await sourceService.writeFile(root, 'a.txt', { content: 'x\n', expectedHash: opened.hash, force: true, eol: '\n' });
    assert.equal(forced.changed, true);
    assert.equal(fs.readFileSync(abs).subarray(3).toString('utf8'), 'x\n');

    // 相同内容不重写
    const same = await sourceService.writeFile(root, 'a.txt', { content: 'x\n', expectedHash: forced.hash });
    assert.equal(same.changed, false);

    // 不新建文件、不留临时文件
    await assert.rejects(sourceService.writeFile(root, 'new.txt', { content: 'n' }), /不存在/);
    assert.deepEqual(fs.readdirSync(root), ['a.txt']);
});

test('scanJson pinpoints errors and duplicate keys; JSONC allows comments and trailing commas', () => {
    const ok = sourceService.checkSyntax('a.json', '{\n  "a": 1,\n  "b": [true, null]\n}\n');
    assert.equal(ok.ok, true);
    assert.equal(ok.language, 'JSON');

    const trailing = sourceService.checkSyntax('a.json', '{\n  "a": 1,\n}');
    assert.equal(trailing.ok, false);
    assert.deepEqual([trailing.diagnostics[0].line, trailing.diagnostics[0].column], [2, 9]);
    assert.match(trailing.diagnostics[0].message, /多余的逗号/);

    const missingComma = sourceService.checkSyntax('a.json', '{"a": 1 "b": 2}');
    assert.equal(missingComma.diagnostics[0].column, 9);

    const dup = sourceService.checkSyntax('a.json', '{"a": 1, "a": 2}');
    assert.equal(dup.ok, true);
    assert.equal(dup.warningCount, 1);

    assert.equal(sourceService.checkSyntax('a.json', '// c\n{}').ok, false);
    const jsonc = sourceService.checkSyntax('tsconfig.json', '{\n  // comment\n  "a": [1, 2,],\n  /* b */\n}');
    assert.equal(jsonc.language, 'JSONC');
    assert.equal(jsonc.ok, true);
    assert.equal(sourceService.checkSyntax('a.json', '').ok, false);
});

test('checkSyntax covers JS / TS / YAML / TOML / CSS and skips unknown types', () => {
    assert.equal(sourceService.checkSyntax('a.js', 'const a = 1;\nexport default a;').ok, true);
    const js = sourceService.checkSyntax('a.js', 'const a = 1;\nconst b = ;');
    assert.equal(js.ok, false);
    assert.equal(js.diagnostics[0].line, 2);
    assert.equal(js.diagnostics[0].column, 11);
    assert.equal(sourceService.checkSyntax('a.jsx', 'const x = <div>{1}</div>;').ok, true);
    assert.equal(sourceService.checkSyntax('a.ts', 'let n: number = 1;\ninterface A { b: string }').ok, true);
    assert.equal(sourceService.checkSyntax('a.ts', 'let n: = 1;').ok, false);
    // CommonJS 顶层 return 不应误报
    assert.equal(sourceService.checkSyntax('a.cjs', 'if (x) return;').ok, true);

    assert.equal(sourceService.checkSyntax('a.yml', 'a: 1\nb:\n  - x\n').ok, true);
    const yaml = sourceService.checkSyntax('a.yaml', 'a: [1, 2\nb: 3');
    assert.equal(yaml.ok, false);
    assert.ok(yaml.diagnostics[0].line >= 1);

    assert.equal(sourceService.checkSyntax('a.toml', 'a = 1\n[t]\nb = "x"').ok, true);
    const toml = sourceService.checkSyntax('Cargo.toml', 'a = 1\nb = = 2');
    assert.equal(toml.ok, false);
    assert.equal(toml.diagnostics[0].line, 2);

    assert.equal(sourceService.checkSyntax('a.css', 'a { color: red; }').ok, true);
    assert.equal(sourceService.checkSyntax('a.css', 'a { color: red; \n b {').ok, false);

    const unknown = sourceService.checkSyntax('a.py', 'def (');
    assert.equal(unknown.supported, false);
    assert.equal(sourceService.languageForPath('Makefile'), null);
});

test('detectEol picks the dominant line ending', () => {
    assert.equal(sourceService.detectEol('a\nb\n'), '\n');
    assert.equal(sourceService.detectEol('a\r\nb\r\nc\n'), '\r\n');
    assert.equal(sourceService.detectEol('single'), '\n');
});
