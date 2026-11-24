'use strict';

const assert = require('node:assert/strict');
const {
    intelligentSecurityCheck,
    intelligentSecurityCheckAsync,
    parsePosixShellAst,
    shutdownAstDaemon
} = require('../PowerShellExecutor/commandSecurityCheck');
const { createSecretRedactor } = require('../PowerShellExecutor/secretRedactor');

async function runTests() {
    try {
        const forbidden = ['rm', 'del', 'format', 'rmdir'];
        const auth = ['sudo', 'net', 'shutdown', 'restart'];

        // 1. POSIX Bash Here-Doc 与管道误报消除验证（macOS 无 pwsh 降级路径）
        const bashScript = [
            "python3 - <<'PYEOF'",
            'import logging',
            'logging.basicConfig(format="%(levelname)s %(message)s")',
            'print("rm -rf / inside python heredoc")',
            'PYEOF',
            'ls -la "/Users/test/format-folder"'
        ].join('\n');
        const posixAst = parsePosixShellAst(bashScript);
        assert.equal(posixAst.commands.length, 2);
        assert.equal(posixAst.commands[0].name, 'python3');
        assert.equal(posixAst.commands[1].name, 'ls');

        // 2. macOS diskutil 抹盘红线验证
        const eraseRes = await intelligentSecurityCheckAsync('diskutil eraseDisk APFS Untitled /dev/disk3', forbidden, auth);
        assert.equal(eraseRes.isForbidden, true);

        const listRes = await intelligentSecurityCheckAsync('diskutil list', forbidden, auth);
        assert.equal(listRes.isForbidden, false);
        assert.equal(listRes.needsAuth, false);

        // 3. 跨平台 VCP_SECRET_REDACT_PATHS 校验
        const redactor = createSecretRedactor([]);
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtYWMtdGVzdCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        assert.equal(redactor.redactSecrets(`Bearer: ${jwt}`), 'Bearer: [REDACTED:JWT_TOKEN]');

        console.log('✅ MacPowerShell 共享 AST 守护核 + POSIX 降级 + 脱敏测试全部通过！');
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