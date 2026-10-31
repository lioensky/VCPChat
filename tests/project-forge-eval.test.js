'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ES = require('../VCPDistributedServer/Plugin/ProjectForge/evalSymbol');
const { runProcess } = require('../VCPDistributedServer/Plugin/ProjectForge/evalProcess');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-eval-test-'));
test.after(async () => { await ES.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });
function fixture(name, text) {
    const file = path.join(tmp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}
async function evaluate(file, symbol, args = {}) {
    return ES.evaluate({
        root: tmp, file, symbol, args,
        sourceHash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    });
}

test('JS: real CJS exports, this, async, setup, tagged values, fresh process', async () => {
    const file = fixture('math.cjs', `
let calls = 0;
exports.add = (a,b) => a+b;
exports.obj = { n: 7, run(x) { return this.n+x; } };
exports.asyncValue = async () => 12;
exports.big = () => 123n;
exports.missing = () => undefined;
exports.count = () => ++calls;
exports.loop = () => { while(true) {} };
exports.cycle = () => { const x={}; x.x=x; return x; };
exports.fail = () => { throw new Error('expected failure'); };
console.log('module startup');
`);
    assert.equal((await evaluate(file, 'add', { args: '[2,3]' })).value, 5);
    assert.equal((await evaluate(file, 'obj.run', { args: [2] })).value, 9);
    assert.equal((await evaluate(file, 'asyncValue')).value, 12);
    assert.equal((await evaluate(file, 'add', { setup: 'return [6, 7];' })).value, 13);
    assert.deepEqual((await evaluate(file, 'big')).value, { $type: 'bigint', value: '123' });
    assert.deepEqual((await evaluate(file, 'missing')).value, { $type: 'undefined' });
    assert.equal((await evaluate(file, 'count')).value, 1);
    assert.equal((await evaluate(file, 'count')).value, 1);
    assert.equal((await evaluate(file, 'cycle')).status, 'encoding_error');
    assert.equal((await evaluate(file, 'fail')).status, 'execution_error');
    assert.equal((await evaluate(file, 'noExport')).status, 'not_callable');
    assert.equal((await evaluate(file, 'loop', { timeoutms: 300 })).status, 'timeout');
    assert.equal((await evaluate(file, 'add', { args: [], setup: 'return [];' })).status, 'invalid_arguments');
});

test('JS: ESM module and bounded logs', async () => {
    const file = fixture('esm.mjs', 'export function run(){ console.log("x".repeat(100000)); return {ok:true}; }');
    const result = await evaluate(file, 'run');
    assert.equal(result.status, 'returned');
    assert.deepEqual(result.value, { $type: 'object', entries: [['ok', true]] });
    assert.equal(result.logs.stdout.truncated, true);
    assert.ok(result.logs.stdout.text.length <= 65536);
});

test('worker spawn failure is explicit', async () => {
    const result = await runProcess(path.join(tmp, 'no-such-runtime'), [], { timeoutMs: 1000 });
    assert.equal(result.status, 'environment_error');
});

test('Python: package relative import, kwargs, async, setup, errors', async t => {
    const probe = await runProcess(process.platform === 'win32' ? 'python.exe' : 'python3', ['--version'], { timeoutMs: 3000 });
    if (probe.status !== 'exited' || probe.exitCode !== 0) return t.skip('Python unavailable');
    fixture('pkg/__init__.py', '');
    fixture('pkg/helper.py', 'BASE = 8\n');
    const file = fixture('pkg/math.py', `
from .helper import BASE
def add(a, *, b=0):
    return a+b+BASE
async def async_value():
    return 9
def big():
    return 10**30
def cycle():
    x=[]
    x.append(x)
    return x
def loop():
    while True:
        pass
`);
    assert.equal((await evaluate(file, 'add', { args: [2], kwargs: { b: 3 } })).value, 13);
    assert.equal((await evaluate(file, 'async_value')).value, 9);
    assert.equal((await evaluate(file, 'add', { setup: 'return [4]' })).value, 12);
    assert.equal((await evaluate(file, 'big')).value.$type, 'bigint');
    assert.equal((await evaluate(file, 'cycle')).status, 'encoding_error');
    assert.equal((await evaluate(file, 'loop', { timeoutms: 300 })).status, 'timeout');
    assert.equal(fs.existsSync(path.join(tmp, 'pkg', '__pycache__')), false);
});

test('Rust: compile, list, exact test, fail, ignored and zero match', async t => {
    const probe = await runProcess('cargo', ['--version'], { timeoutMs: 3000 });
    if (probe.status !== 'exited' || probe.exitCode !== 0) return t.skip('Cargo unavailable');
    fixture('Cargo.toml', '[package]\nname="pf_eval_fixture"\nversion="0.1.0"\nedition="2021"\n');
    const file = fixture('src/lib.rs', `
mod child;
#[cfg(test)]
mod tests {
    #[test]
    fn success() { assert_eq!(2+2,4); }
    #[test]
    fn failure() { assert_eq!(1,2); }
    #[test]
    #[ignore]
    fn ignored() {}
}
`);
    const child = fixture('src/child.rs', '#[test]\nfn success() { assert!(true); }\nfn absent() {}\n');
    assert.equal((await evaluate(child, 'success', { timeoutms: 30000 })).status, 'passed');
    assert.equal((await evaluate(child, 'tests.success', { timeoutms: 30000 })).status, 'not_found');
    assert.equal((await evaluate(child, 'absent', { timeoutms: 30000 })).status, 'not_found');
    assert.equal((await evaluate(file, 'tests.success', { timeoutms: 30000 })).status, 'passed');
    assert.equal((await evaluate(file, 'tests.failure', { timeoutms: 30000 })).status, 'test_failed');
    assert.equal((await evaluate(file, 'tests.ignored', { timeoutms: 30000 })).status, 'not_executed');
    assert.equal((await evaluate(file, 'tests.absent', { timeoutms: 30000 })).status, 'not_found');
});