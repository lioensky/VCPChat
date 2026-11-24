'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
    intelligentSecurityCheck,
    intelligentSecurityCheckAsync,
    parsePosixShellAst,
    shutdownAstDaemon
} = require('./commandSecurityCheck');
const { createSecretRedactor } = require('./secretRedactor');

async function runAstAndDaemonTests() {
    const forbiddenCommands = ['rm', 'del', 'format', 'rmdir'];
    const authRequiredCommands = ['net', 'shutdown', 'restart', 'remove-item', 'set-item'];

    const inlinePythonProbe = [
        '& {',
        "  Set-Location -LiteralPath 'C:\\Workspace\\DemoApp'",
        "  $py = 'C:\\Workspace\\DemoApp\\.venv\\Scripts\\python.exe'",
        "  $source = @'",
        'import logging',
        'logging.basicConfig(level=logging.DEBUG, format="%(name)s %(message)s", force=True)',
        'print("rm -rf / and format C: inside python string literal")',
        "'@",
        '  $source | & $py -I -',
        '}'
    ].join('\n');

    const cases = [
        {
            name: 'L0 直通：内置 Format-Table 与管道只读命令绝不误报 format',
            command: 'Get-ChildItem -Force C:\\Workspace | Select-Object Mode,Length,Name | Format-Table -AutoSize',
            expectedForbidden: false,
            expectedAuth: false
        },
        {
            name: 'L0 直通：Python here-string 探针内含 format= 与敏感词字面量不误报',
            command: inlinePythonProbe,
            expectedForbidden: false,
            expectedAuth: false
        },
        {
            name: 'L0 直通：路径中包含 rm / net 字面量不误报',
            command: 'Get-ChildItem "C:\\Windows\\Microsoft.NET\\Framework64\\platform-tools"',
            expectedForbidden: false,
            expectedAuth: false
        },
        {
            name: 'L1 授权：命中 authRequiredCommands 的 Set-Item 命令节点',
            command: 'Set-Item -Path "Env:ANDROID_HOME" -Value "H:\\SDK\\platform-tools"',
            expectedForbidden: false,
            expectedAuth: true
        },
        {
            name: 'L1 授权：Remove-Item 普通目录走交互式授权',
            command: 'Remove-Item -Path "C:\\temp\\test-folder" -Recurse -Force',
            expectedForbidden: false,
            expectedAuth: true
        },
        {
            name: 'L1 授权：Invoke-Expression 动态执行拦截为需授权',
            command: 'Invoke-Expression $untrustedPayload',
            expectedForbidden: false,
            expectedAuth: true
        },
        {
            name: 'L1 授权：未知来源的动态变量命令调用 & $unknownBin',
            command: '& $unknownDynamicBinary --help',
            expectedForbidden: false,
            expectedAuth: true
        },
        {
            name: 'L2 硬拦：真实调用被禁止的 rm 命令节点',
            command: 'rm -rf /important/project/subdir',
            expectedForbidden: true,
            expectedAuth: false
        },
        {
            name: 'L2 硬拦：真实调用裸 format 磁盘命令节点',
            command: 'format D: /FS:NTFS /Q',
            expectedForbidden: true,
            expectedAuth: false
        },
        {
            name: 'L2 硬拦：Format-Volume 高危磁盘命令硬拦截',
            command: 'Format-Volume -DriveLetter E -FileSystem NTFS',
            expectedForbidden: true,
            expectedAuth: false
        },
        {
            name: 'L2 硬拦：macOS diskutil eraseDisk 毁盘红线硬拦截',
            command: 'diskutil eraseDisk APFS Untitled /dev/disk3',
            expectedForbidden: true,
            expectedAuth: false
        },
        {
            name: 'L2 硬拦：Remove-Item 指向盘符根目录递归强删升级为 L2 阻断',
            command: 'Remove-Item -Path "C:\\" -Recurse -Force',
            expectedForbidden: true,
            expectedAuth: false
        }
    ];

    // 先通过常驻 JSON-RPC 守护进程异步验证全部用例
    for (const tc of cases) {
        const res = await intelligentSecurityCheckAsync(tc.command, forbiddenCommands, authRequiredCommands);
        assert.equal(res.isForbidden, tc.expectedForbidden, `[Async ${tc.name}] isForbidden 不符: ${res.reason}`);
        assert.equal(res.needsAuth, tc.expectedAuth, `[Async ${tc.name}] needsAuth 不符: ${res.reason}`);
    }

    // 再压测常驻守护进程 10 条未缓存新语句流水线延迟
    const t0 = performance.now();
    const batch = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
            intelligentSecurityCheckAsync(`Write-Output "daemon-probe-${idx}" | Format-Table`, forbiddenCommands, authRequiredCommands)
        )
    );
    const avgMs = (performance.now() - t0) / batch.length;
    for (const r of batch) {
        assert.equal(r.isForbidden, false);
        assert.equal(r.needsAuth, false);
    }

    // 验证同步兼容入口与 Mac POSIX Shell Here-Doc 降级状态机
    const syncRes = intelligentSecurityCheck('Get-Location', forbiddenCommands, authRequiredCommands);
    assert.equal(syncRes.isForbidden, false);

    // Run the parser only, with a parent-enforced deadline.
    const childProbe = require('node:child_process').spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const {parsePosixShellAst} = require('./commandSecurityCheck');
        for (const text of ['echo ok > report', 'cat < report']) {
            const result = parsePosixShellAst(text);
            assert.equal(result.errors[0].id, 'UnsupportedPosixRedirection');
        }
    `], { cwd: __dirname, timeout: 4000, encoding: 'utf8' });
    assert.ifError(childProbe.error);
    assert.equal(childProbe.status, 0, childProbe.stderr);
    const posixAst = parsePosixShellAst([
        "python3 - <<'EOF'",
        'import logging',
        'logging.basicConfig(format="%(message)s")',
        'print("rm -rf /")',
        'EOF'
    ].join('\n'));
    assert.equal(posixAst.commands.length, 1);
    assert.equal(posixAst.commands[0].name, 'python3');

    console.log(`✅ AST 命令级判定 (${cases.length}/${cases.length}) + 常驻 JSON-RPC 10 路并发通过（单条均摊 ${avgMs.toFixed(2)}ms）+ POSIX 降级通过`);
}

function runRedactorTests() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-redactor-test-'));
    try {
        const envFile = path.join(tmpDir, 'host.env');
        const yamlFile = path.join(tmpDir, 'server.yaml');
        const sampleKey = 'DEMO_99aabbccddeeff0011223344';
        const sampleSecret = 'SuperSecretLiveKitValue_AbCdEfGh1234567890';
        const vcpApiKey = 'vcp_master_prod_token_9876543210abcdef';

        fs.writeFileSync(envFile, [
            `SELF_USE_ROOM_API_KEY=${sampleKey}`,
            `SELF_USE_ROOM_API_SECRET="${sampleSecret}"`,
            `DEMO_SERVICE_API_KEY='${vcpApiKey}'`,
            'PORT=17980',
            'HOST=127.0.0.1'
        ].join('\n'), 'utf8');

        fs.writeFileSync(yamlFile, [
            'port: 17980',
            'bind_addresses:',
            '  - 127.0.0.1',
            'keys:',
            `  ${sampleKey}: ${sampleSecret}`
        ].join('\n'), 'utf8');

        const redactor = createSecretRedactor([tmpDir]);
        const b64Secret = Buffer.from(sampleSecret, 'utf8').toString('base64');
        const fakeJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb29tIjoidmxnIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

        const scrubbed = redactor.redactSecrets([
            'Connected to 127.0.0.1:17980',
            `Leak1=${sampleKey}`,
            `Leak2=${sampleSecret}`,
            `Leak3_B64=${b64Secret}`,
            `Leak4_VCP=${vcpApiKey}`,
            `Authorization: Bearer ${fakeJwt}`
        ].join('\n'));

        assert.ok(scrubbed.includes('127.0.0.1:17980'));
        assert.ok(!scrubbed.includes(sampleKey));
        assert.ok(!scrubbed.includes(sampleSecret));
        assert.ok(!scrubbed.includes(b64Secret));
        assert.ok(!scrubbed.includes(vcpApiKey));
        assert.ok(!scrubbed.includes(fakeJwt));
        console.log('✅ SecretRedactor 明文/Base64/YAML/JWT 出站脱敏测试全部通过');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function runTests() {
    try {
        await runAstAndDaemonTests();
        runRedactorTests();
        console.log('🎉 PowerShellExecutor 常驻 JSON-RPC 守护与脱敏套件全绿！');
    } finally {
        shutdownAstDaemon();
    }
}

if (require.main === module) {
    runTests().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}

module.exports = { intelligentSecurityCheck, intelligentSecurityCheckAsync, runTests };