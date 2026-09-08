const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
const ipcHandlers = new Map();

Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'electron') {
        return {
            BrowserWindow: class BrowserWindow {},
            ipcMain: {
                on(channel, handler) {
                    ipcHandlers.set(channel, handler);
                },
                handle(channel, handler) {
                    ipcHandlers.set(channel, handler);
                }
            },
            clipboard: {
                readText: () => '',
                writeText: () => {}
            }
        };
    }

    if (request === 'node-pty') {
        return { spawn: () => { throw new Error('PTY must not start in parser tests.'); } };
    }

    if (request === 'chokidar') {
        return {
            watch: () => ({
                on() { return this; },
                close() {}
            })
        };
    }

    return originalLoad(request, parent, isMain);
};

const {
    parseInteractiveSequence,
    parseWaitDuration,
    parseTerminalKey,
    cleanup
} = require('./PowerShellExecutor');

Module._load = originalLoad;

function runTests() {
    assert.equal(parseWaitDuration('50ms'), 50);
    assert.equal(parseWaitDuration('1.5s'), 1500);
    assert.equal(parseWaitDuration(125), 125);
    assert.throws(() => parseWaitDuration('soon'), /无效 wait 时长/);

    assert.deepEqual(parseTerminalKey('enter'), {
        keyName: 'enter',
        repeat: 1,
        data: '\r'
    });
    assert.deepEqual(parseTerminalKey('up'), {
        keyName: 'up',
        repeat: 1,
        data: '\x1b[A'
    });
    assert.deepEqual(parseTerminalKey('ctrl+c*2'), {
        keyName: 'ctrl+c',
        repeat: 2,
        data: '\x03\x03'
    });
    assert.throws(() => parseTerminalKey('f13'), /不支持的终端按键/);
    assert.throws(() => parseTerminalKey('enter*11'), /重复次数必须在 1 到 10/);

    const steps = parseInteractiveSequence({
        command: 'RunInteractiveSequence',
        queryVisible9: '300',
        paste5: '请分析当前项目',
        wait2: '1500ms',
        key7: 'enter',
        command1: 'snow',
        key3: 'down',
        wait6: '100ms',
        newSession: true
    });

    assert.deepEqual(
        steps.map(step => [step.index, step.type]),
        [
            [1, 'command'],
            [2, 'wait'],
            [3, 'key'],
            [5, 'paste'],
            [6, 'wait'],
            [7, 'key'],
            [9, 'queryVisible']
        ]
    );
    assert.equal(steps.find(step => step.type === 'wait').durationMs, 1500);
    assert.equal(steps.find(step => step.type === 'queryVisible').maxLines, 300);

    assert.throws(
        () => parseInteractiveSequence({ command1: 'snow', wait1: '50ms' }),
        /步骤编号 1 重复/
    );
    assert.throws(
        () => parseInteractiveSequence({ wait1: '60001ms' }),
        /单个 wait 步骤/
    );
    assert.throws(
        () => parseInteractiveSequence({ wait1: '50ms' }),
        /交互序列不能只包含 wait/
    );
    assert.throws(
        () => parseInteractiveSequence({
            wait1: '60000ms',
            wait2: '60000ms',
            wait3: '60000ms',
            wait4: '60000ms',
            wait5: '60000ms',
            wait6: '1ms'
        }),
        /序列累计等待不能超过/
    );
    assert.throws(
        () => parseInteractiveSequence({ command: 'RunInteractiveSequence' }),
        /至少需要一个带全局序号的步骤/
    );

    cleanup();
    console.log('Interactive sequence parser tests passed.');
}

try {
    runTests();
} catch (error) {
    cleanup();
    console.error(error);
    process.exitCode = 1;
}