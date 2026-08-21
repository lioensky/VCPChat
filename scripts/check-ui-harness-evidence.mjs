import { spawn } from 'node:child_process';

const checks = [
    ['npm', ['run', 'guard:ui-interaction']],
    ['npm', ['run', 'guard:ui-async-state']],
    ['npm', ['run', 'guard:ui-task-journeys']],
    ['npm', ['run', 'test:ui-motion-contract']],
    ['npm', ['run', 'test:electron-ui-apps']],
    ['npm', ['run', 'test:electron-main-chat-sequences']],
    ['npm', ['run', 'test:electron-lifecycle-stress']],
    ['npm', ['run', 'pack:check']],
];

for (const [command, args] of checks) {
    console.log(`\n[ui-harness-evidence] ${command} ${args.join(' ')}`);
    const exitCode = await new Promise(resolve => {
        const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
        child.once('error', error => { console.error(error); resolve(1); });
        child.once('exit', code => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
        console.error(`[ui-harness-evidence] failed: ${command} ${args.join(' ')}`);
        process.exitCode = exitCode;
        break;
    }
}
if (!process.exitCode) console.log('\nUI Harness evidence matrix passed on the current host. Windows, packaged launch, and manual soak remain external evidence.');
