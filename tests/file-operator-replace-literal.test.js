const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const pluginPath = path.resolve(__dirname, '../VCPDistributedServer/Plugin/FileOperator/FileOperator.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const pluginRequire = createRequire(pluginPath);
const pluginEnvFiles = new Set(['config.env', '.env'].map(name => path.join(path.dirname(pluginPath), name)));

// Ignore any local config.env / .env so the test only sees the environment given here.
function loadPlugin(allowedDir) {
    const pluginFs = { ...fs, existsSync: file => !pluginEnvFiles.has(path.resolve(file)) && fs.existsSync(file) };
    const context = {
        module: { exports: {} },
        __dirname: path.dirname(pluginPath),
        process: {
            env: { ALLOWED_DIRECTORIES: allowedDir, DEBUG_MODE: 'false' },
            platform: process.platform,
            cwd: () => process.cwd()
        },
        Buffer, console,
        require: id => (id === 'fs' ? pluginFs : pluginRequire(id))
    };
    vm.runInNewContext(source, context, { filename: pluginPath });
    return context.module.exports;
}

function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-operator-replace-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, plugin: loadPlugin(dir) };
}

test('ApplyDiff writes $&, $$, $` and $\' in the replace text literally', async t => {
    const { dir, plugin } = setup(t);
    const file = path.join(dir, 'script.ps1');
    for (const replace of [
        'Write-Host "$&"',
        '$price = "$$5"',
        'Write-Host "$`|$\'"',
        "return text.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');"
    ]) {
        fs.writeFileSync(file, 'start\nTARGET\nend\n');
        await plugin.processToolCall({ command: 'ApplyDiff', filePath: file, target: 'TARGET', replace });
        assert.equal(fs.readFileSync(file, 'utf8'), `start\n${replace}\nend\n`);
    }
});

test('ApplyDiff diffContent and UpdateHistory also keep $& literally', async t => {
    const { dir, plugin } = setup(t);
    const file = path.join(dir, 'script.sh');
    fs.writeFileSync(file, 'start\nTARGET\nend\n');
    await plugin.processToolCall({
        command: 'ApplyDiff',
        filePath: file,
        diffContent: '<<<<<<< SEARCH\n-------\nTARGET\n=======\necho "$$ $&"\n>>>>>>> REPLACE'
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'start\necho "$$ $&"\nend\n');

    const history = path.join(dir, 'history.json');
    fs.writeFileSync(history, JSON.stringify([{ role: 'assistant', content: 'run TARGET now' }]));
    await plugin.processToolCall({ command: 'UpdateHistory', filePath: history, target: 'TARGET', replace: '"$&"' });
    assert.equal(JSON.parse(fs.readFileSync(history, 'utf8'))[0].content, 'run "$&" now');
});

test('literal replacement still changes only the first match and keeps CRLF line endings', async t => {
    const { dir, plugin } = setup(t);
    const file = path.join(dir, 'crlf.txt');
    fs.writeFileSync(file, 'head\r\nTARGET\r\nTARGET\r\n');
    await plugin.processToolCall({ command: 'ApplyDiff', filePath: file, target: 'TARGET', replace: 'one\n$&' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'head\r\none\r\n$&\r\nTARGET\r\n');
});
