const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('PowerShellExecutor injects pager suppression in PTY env, probe, wrapper and admin command', () => {
    const sourcePath = path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js');
    const source = fs.readFileSync(sourcePath, 'utf8');

    // 1. PTY spawn 进程环境变量注入
    assert.match(source, /GIT_PAGER:\s*['"]cat['"]/);
    assert.match(source, /PAGER:\s*['"]cat['"]/);
    assert.match(source, /GIT_TERMINAL_PROMPT:\s*['"]0['"]/);

    // 2. 初始化探针 (initializationCommand) 中对 Pager 和内置命令的压制与覆盖
    assert.match(source, /\$env:GIT_PAGER\s*=\s*['"]cat['"]/);
    assert.match(source, /\$env:PAGER\s*=\s*['"]cat['"]/);
    assert.match(source, /function\s+global:more/);
    assert.match(source, /function\s+global:help/);

    // 3. 同步执行包装命令 (wrappedCommand) 再次确保防分页生效
    assert.match(source, /\$env:PAGER\s*=\s*'cat'/);
    assert.match(source, /\$env:GIT_PAGER\s*=\s*'cat'/);

    // 4. 管理员执行链路同样防御分页挂起
    const requireAdminIndex = source.indexOf('if (requireAdmin)');
    assert.ok(requireAdminIndex !== -1);
    const adminSegment = source.slice(requireAdminIndex, requireAdminIndex + 500);
    assert.match(adminSegment, /GIT_PAGER/);
});