const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {parse} = require('@babel/parser');
const {resolveConfirmationScript} = require('../VCPDistributedServer/Plugin/PowerShellExecutor/nativeHelperPath.js');

function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-helper-'));
    try { run(root); }
    finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('terminal-helper-'));
        fs.rmSync(root, {recursive:true,force:true});
    }
}

function script(directory) {
    fs.mkdirSync(directory, {recursive:true});
    const file = path.join(directory, 'AdminConfirm.py');
    fs.writeFileSync(file, '# fixture only\n');
    return file;
}

test('development helper uses the real source file', () => fixture(root => {
    const expected = script(root);
    assert.equal(resolveConfirmationScript(root), expected);
}));

test('ASAR helper resolves to the physical unpacked directory', () => fixture(root => {
    const relative = path.join('Plugin', 'PowerShellExecutor');
    const expected = script(path.join(root, 'app.asar.unpacked', relative));
    script(path.join(root, 'app.asar', relative));
    assert.equal(resolveConfirmationScript(path.join(root, 'app.asar', relative)), expected);
}));

test('an already unpacked path is not rewritten again', () => fixture(root => {
    const directory = path.join(root, 'app.asar.unpacked', 'Plugin');
    const expected = script(directory);
    assert.equal(resolveConfirmationScript(directory), expected);
}));

test('missing physical helper does not fall back to a virtual ASAR entry', () => fixture(root => {
    const directory = path.join(root, 'app.asar', 'Plugin');
    script(directory);
    assert.throws(() => resolveConfirmationScript(directory), /确认脚本缺失/);
}));

test('both confirmation callers reject a missing helper and clean up their temporary file without spawning', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
    const ast = parse(source, {sourceType:'script'});
    for (const name of ['executeAdminCommand', 'requestInteractiveConfirmation']) {
        const node = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        assert.ok(node, 'exercise actual production function ' + name);
        let cleaned = 0, spawned = 0;
        const fn = vm.runInNewContext('(' + source.slice(node.start, node.end) + ')', {
            tmp:{file:(options,callback)=>callback(null,'unused-output',1,()=>cleaned++)},
            resolveConfirmationScript:()=>{throw new Error('missing-native-helper');},
            __dirname:'virtual-app.asar/plugin',
            path,
            Buffer,
            spawn:()=>{spawned++;throw new Error('unexpected spawn');},
        });
        await assert.rejects(fn('fixture command'), /missing-native-helper/);
        assert.equal(cleaned, 1, name + ' releases its temporary descriptor');
        assert.equal(spawned, 0, name + ' fails before external execution');
    }
});
