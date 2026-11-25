'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');

const AST_CACHE_LIMIT = 256;
const AST_WARMUP_TIMEOUT_MS = 5000;
const AST_RPC_TIMEOUT_MS = 1500;
// Trial default: release the parser after five minutes without RPC work.
const AST_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const astCache = new Map();

const SAFE_DISPLAY_CMDLETS = new Set([
    'format-table', 'format-list', 'format-wide', 'format-custom', 'format-hex',
    'out-string', 'out-null', 'select-object', 'where-object', 'sort-object',
    'measure-object', 'group-object', 'write-output', 'write-host',
    'get-childitem', 'get-content', 'get-item', 'get-location', 'get-process',
    'get-netipaddress', 'get-nettcpconnection'
]);

const BUILTIN_L2_DISK_COMMANDS = new Set([
    'format-volume', 'format-disk', 'clear-disk', 'initialize-disk', 'diskpart',
    'newfs_apfs', 'newfs_hfs', 'newfs_exfat', 'newfs_msdos'
]);

const MAC_DISKUTIL_DESTRUCTIVE_VERBS = new Set([
    'erasedisk', 'erasevolume', 'partitiondisk', 'zerodisk', 'randomdisk', 'deletecontainer'
]);

const DELETE_COMMAND_STEMS = new Set([
    'remove-item', 'rm', 'del', 'erase', 'rd', 'rmdir'
]);

const DYNAMIC_EXEC_STEMS = new Set(['invoke-expression', 'iex', 'eval']);
const SHELL_ENGINE_STEMS = new Set(['powershell', 'pwsh']);
const ENCODED_CMD_FLAGS = new Set(['e', 'ec', 'enc', 'encodedcommand']);

const PS_DAEMON_SCRIPT = [
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$quoteChars = [char[]]@(39, 96, 34)',
    '$rootRe = "^([A-Za-z]:[\\\\/]?(\\*+)?|[\\\\/](\\*+)?)$"',
    'function Invoke-AstParse([string]$b64) {',
    '  $code = if ($b64) { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64)) } else { "" }',
    '  $tokens = $null; $errors = $null',
    '  $ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)',
    '  $vars = @{}',
    '  foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {',
    '    if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {',
    '      $vn = ($a.Left.VariablePath.UserPath -replace "^(?:script|local|global|private):", "").ToLowerInvariant()',
    '      $rhsExpr = $null',
    '      if ($a.Right -is [System.Management.Automation.Language.CommandExpressionAst]) {',
    '        $rhsExpr = $a.Right.Expression',
    '      } elseif ($a.Right -is [System.Management.Automation.Language.PipelineAst] -and $a.Right.PipelineElements.Count -eq 1) {',
    '        $pe = $a.Right.PipelineElements[0]',
    '        if ($pe -is [System.Management.Automation.Language.CommandExpressionAst]) {',
    '          $rhsExpr = $pe.Expression',
    '        } elseif ($pe -is [System.Management.Automation.Language.CommandAst] -and $pe.GetCommandName() -ieq "Join-Path") {',
    '          $strEls = @($pe.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.StringConstantExpressionAst] })',
    '          if ($strEls.Count -ge 2) { $vars[$vn] = [string]$strEls[-1].Value }',
    '        }',
    '      }',
    '      if ($rhsExpr -is [System.Management.Automation.Language.StringConstantExpressionAst]) {',
    '        $vars[$vn] = [string]$rhsExpr.Value',
    '      } elseif ($rhsExpr -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {',
    '        if ([string]$rhsExpr.Value -match "[\\\\/]([A-Za-z0-9._-]+)$") { $vars[$vn] = $Matches[1] }',
    '      }',
    '    }',
    '  }',
    '  $errList = @()',
    '  foreach ($e in $errors) { $errList += @{ id = [string]$e.ErrorId; line = [int]$e.Extent.StartLineNumber } }',
    '  $cmdList = @()',
    '  foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {',
    '    $els = $c.CommandElements; if ($els.Count -eq 0) { continue }',
    '    $first = $els[0]',
    '    if ($first -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { continue }',
    '    $name = $c.GetCommandName()',
    '    if ($null -eq $name) {',
    '      if ($first -is [System.Management.Automation.Language.VariableExpressionAst]) {',
    '        $vn = ($first.VariablePath.UserPath -replace "^(?:script|local|global|private):", "").ToLowerInvariant()',
    '        if ($vars.ContainsKey($vn)) { $name = [string]$vars[$vn] }',
    '      } elseif ($first -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {',
    '        if ([string]$first.Value -match "[\\\\/]([A-Za-z0-9._-]+)$") { $name = $Matches[1] }',
    '      } elseif ($first -is [System.Management.Automation.Language.ParenExpressionAst] -and $first.Pipeline -is [System.Management.Automation.Language.PipelineAst] -and $first.Pipeline.PipelineElements.Count -eq 1) {',
    '        $inner = $first.Pipeline.PipelineElements[0]',
    '        if ($inner -is [System.Management.Automation.Language.CommandAst] -and $inner.GetCommandName() -ieq "Join-Path") {',
    '          $strEls = @($inner.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.StringConstantExpressionAst] })',
    '          if ($strEls.Count -ge 2) { $name = [string]$strEls[-1].Value }',
    '        }',
    '      }',
    '    }',
    '    $params = @(); $subArgs = @(); $targetsRoot = $false; $hasRunAs = $false',
    '    for ($i = 1; $i -lt $els.Count; $i++) {',
    '      $el = $els[$i]',
    '      if ($el -is [System.Management.Automation.Language.CommandParameterAst]) {',
    '        $pn = ([string]$el.ParameterName).ToLowerInvariant(); $params += $pn',
    '        if ($null -ne $el.Argument) {',
    '          $pArg = $el.Argument.Extent.Text.Trim($quoteChars)',
    '          if ($pArg -match $rootRe) { $targetsRoot = $true }',
    '        }',
    '        if ($pn -eq "verb") {',
    '          $argTxt = if ($null -ne $el.Argument) { $el.Argument.Extent.Text } elseif (($i + 1) -lt $els.Count) { $els[$i + 1].Extent.Text } else { "" }',
    '          if ($argTxt.Trim($quoteChars) -ieq "RunAs") { $hasRunAs = $true }',
    '        }',
    '      } else {',
    '        $txt = if ($el -is [System.Management.Automation.Language.StringConstantExpressionAst]) { [string]$el.Value } else { $el.Extent.Text.Trim($quoteChars) }',
    '        if ($subArgs.Count -lt 4 -and $txt.Length -le 120) { $subArgs += $txt }',
    '        if ($txt -match $rootRe) { $targetsRoot = $true }',
    '      }',
    '    }',
    '    $cmdList += @{ name = $name; line = [int]$c.Extent.StartLineNumber; params = $params; subArgs = $subArgs; targetsRoot = $targetsRoot; hasRunAs = $hasRunAs }',
    '  }',
    '  return @{ errors = $errList; commands = $cmdList }',
    '}',
    'if ($env:VCP_AST_ONESHOT -eq "1") {',
    '  $res = Invoke-AstParse ([Console]::In.ReadToEnd().Trim())',
    '  $res | ConvertTo-Json -Compress -Depth 6',
    '  exit 0',
    '}',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {',
    '  if (-not $line.Trim()) { continue }',
    '  $reqId = $null',
    '  try {',
    '    $req = $line | ConvertFrom-Json',
    '    $reqId = $req.id',
    '    $res = Invoke-AstParse ([string]$req.params.b64)',
    '    [Console]::Out.WriteLine((@{ jsonrpc = "2.0"; id = $reqId; result = $res } | ConvertTo-Json -Compress -Depth 6))',
    '    [Console]::Out.Flush()',
    '  } catch {',
    '    [Console]::Out.WriteLine((@{ jsonrpc = "2.0"; id = $reqId; error = @{ code = -32603; message = [string]$_.Exception.Message } } | ConvertTo-Json -Compress -Depth 4))',
    '    [Console]::Out.Flush()',
    '  }',
    '}'
].join('\n');

const ENCODED_DAEMON_SCRIPT = Buffer.from(PS_DAEMON_SCRIPT, 'utf16le').toString('base64');

let resolvedPsBinary = undefined;
function resolvePowerShellBinary() {
    if (resolvedPsBinary !== undefined) return resolvedPsBinary;
    if (os.platform() === 'win32') {
        const ps7 = path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
        resolvedPsBinary = fs.existsSync(ps7) ? ps7 : 'powershell.exe';
        return resolvedPsBinary;
    }
    const candidates = [
        path.join(process.env.HOME || '', '.local', 'bin', 'pwsh'),
        '/opt/homebrew/bin/pwsh',
        '/usr/local/bin/pwsh'
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) {
            resolvedPsBinary = p;
            return resolvedPsBinary;
        }
    }
    try {
        const found = execFileSync('which', ['pwsh'], { encoding: 'utf8', timeout: 2000 }).trim();
        if (found && fs.existsSync(found)) {
            resolvedPsBinary = found;
            return resolvedPsBinary;
        }
    } catch {
        // 未安装 pwsh，自动降级至 POSIX 词法状态机
    }
    resolvedPsBinary = null;
    return null;
}

function toArray(val) {
    return Array.isArray(val) ? val : (val != null ? [val] : []);
}

function normalizeAstPayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Object.prototype.hasOwnProperty.call(parsed, 'errors') ||
        !Object.prototype.hasOwnProperty.call(parsed, 'commands')) {
        throw new Error('AST_INVALID_PAYLOAD');
    }
    return {
        errors: toArray(parsed.errors),
        commands: toArray(parsed.commands).map((c) => ({
            name: typeof c.name === 'string' && c.name ? c.name : null,
            line: Number(c.line) || 1,
            params: toArray(c.params).map((p) => String(p).toLowerCase()),
            subArgs: toArray(c.subArgs).map((s) => String(s)),
            targetsRoot: Boolean(c.targetsRoot),
            hasRunAs: Boolean(c.hasRunAs)
        }))
    };
}

function getCachedAst(command) {
    if (!astCache.has(command)) return null;
    const cached = astCache.get(command);
    astCache.delete(command);
    astCache.set(command, cached);
    return cached;
}

function setCachedAst(command, normalized) {
    if (astCache.size >= AST_CACHE_LIMIT) {
        astCache.delete(astCache.keys().next().value);
    }
    astCache.set(command, normalized);
    return normalized;
}

let daemonProc = null;
let daemonRl = null;
let daemonWarmed = false;
let rpcSeq = 0;
const pendingRpc = new Map();

let idleTimer = null;

function cancelIdleTimer() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
}

function updateDaemonRefState() {
    cancelIdleTimer();
    if (!daemonProc) return;
    if (pendingRpc.size > 0) {
        daemonProc.ref();
        daemonProc.stdout?.ref?.();
    } else {
        const owner = daemonProc;
        const timer = setTimeout(() => {
            if (idleTimer !== timer || daemonProc !== owner || pendingRpc.size !== 0) return;
            idleTimer = null;
            shutdownAstDaemon('AST daemon idle');
        }, AST_IDLE_TIMEOUT_MS);
        idleTimer = timer;
        timer.unref();
        daemonProc.unref();
        daemonProc.stdout?.unref?.();
        daemonProc.stderr?.unref?.();
        daemonProc.stdin?.unref?.();
    }
}

function shutdownAstDaemon(reason = 'AST daemon shutdown') {
    cancelIdleTimer();
    if (daemonRl) {
        try { daemonRl.close(); } catch { /* ignore */ }
        daemonRl = null;
    }
    if (daemonProc) {
        const proc = daemonProc;
        daemonProc = null;
        daemonWarmed = false;
        try { proc.kill(); } catch { /* ignore */ }
    }
    for (const [, entry] of pendingRpc) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
    }
    pendingRpc.clear();
}

function ensureAstDaemon(psBin) {
    if (daemonProc && daemonProc.exitCode === null && !daemonProc.killed) {
        return daemonProc;
    }
    shutdownAstDaemon('Restarting AST daemon');
    const child = spawn(
        psBin,
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', ENCODED_DAEMON_SCRIPT],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    daemonProc = child;
    daemonRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    daemonRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        let msg;
        try { msg = JSON.parse(trimmed); } catch { return; }
        const pending = pendingRpc.get(msg.id);
        if (!pending) return;
        pendingRpc.delete(msg.id);
        clearTimeout(pending.timer);
        daemonWarmed = true;
        updateDaemonRefState();
        if (msg.jsonrpc !== '2.0' || msg.error) {
            pending.reject(new Error(msg.error?.message || 'AST RPC error'));
        } else {
            try {
                pending.resolve(normalizeAstPayload(msg.result));
            } catch (err) {
                pending.reject(err);
                if (daemonProc === child) shutdownAstDaemon('AST RPC invalid payload');
            }
        }
    });

    child.on('error', (err) => {
        if (daemonProc === child) shutdownAstDaemon(err.message);
    });
    child.on('exit', (code) => {
        if (daemonProc === child) shutdownAstDaemon(`AST daemon exited (${code})`);
    });

    updateDaemonRefState();
    return child;
}

function requestDaemonAst(command, psBin) {
    return new Promise((resolve, reject) => {
        const child = ensureAstDaemon(psBin);
        const id = ++rpcSeq;
        const timeoutMs = daemonWarmed ? AST_RPC_TIMEOUT_MS : AST_WARMUP_TIMEOUT_MS;
        const timer = setTimeout(() => {
            pendingRpc.delete(id);
            shutdownAstDaemon('AST RPC timeout');
            reject(new Error('AST_RPC_TIMEOUT'));
        }, timeoutMs);

        pendingRpc.set(id, { resolve, reject, timer });
        updateDaemonRefState();

        const payload = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'parse',
            params: { b64: Buffer.from(command, 'utf8').toString('base64') }
        }) + '\n';

        child.stdin.write(payload, 'utf8', (err) => {
            if (err && pendingRpc.has(id)) {
                pendingRpc.delete(id);
                clearTimeout(timer);
                updateDaemonRefState();
                reject(err);
            }
        });
    });
}

function parsePosixShellAst(command) {
    const commands = [];
    let line = 1;
    let i = 0;
    const n = command.length;
    let curTokens = [];
    let curLine = 1;

    const flushCmd = () => {
        let idx = 0;
        while (idx < curTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(curTokens[idx])) idx++;
        if (idx < curTokens.length && curTokens[idx] === 'sudo') {
            const nextName = curTokens[idx + 1] || 'sudo';
            commands.push({
                name: nextName.startsWith('$') ? null : nextName,
                line: curLine,
                params: [],
                subArgs: curTokens.slice(idx + 2, idx + 6),
                targetsRoot: curTokens.slice(idx + 1).some((t) => /^\/(\*+)?$/.test(t)),
                hasRunAs: true
            });
        } else if (idx < curTokens.length) {
            const rawCmd = curTokens[idx];
            const args = curTokens.slice(idx + 1);
            commands.push({
                name: rawCmd.startsWith('$') ? null : rawCmd,
                line: curLine,
                params: args.filter((a) => a.startsWith('-')).map((a) => a.replace(/^-+/, '').toLowerCase()),
                subArgs: args.filter((a) => !a.startsWith('-')).slice(0, 4),
                targetsRoot: args.some((t) => /^\/(\*+)?$/.test(t)),
                hasRunAs: false
            });
        }
        curTokens = [];
    };

    let previousOffset = -1;
    while (i < n) {
        if (i <= previousOffset) throw new Error('POSIX scanner made no progress');
        previousOffset = i;
        const ch = command[i];
        if (ch === '\n') { flushCmd(); line++; i++; continue; }
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '#') {
            while (i < n && command[i] !== '\n') i++;
            continue;
        }
        if (ch === ';' || ch === '|' || ch === '&') {
            flushCmd();
            if (command[i + 1] === ch) i += 2;
            else i++;
            continue;
        }
        if (ch === '<' && command[i + 1] === '<') {
            i += 2;
            if (command[i] === '-') i++;
            while (i < n && /[ \t]/.test(command[i])) i++;
            let delim = '';
            const quote = (command[i] === "'" || command[i] === '"') ? command[i++] : null;
            while (i < n && (quote ? command[i] !== quote : !/\s/.test(command[i]))) delim += command[i++];
            if (quote && command[i] === quote) i++;
            while (i < n && command[i] !== '\n') i++;
            if (i < n && command[i] === '\n') { line++; i++; }
            while (i < n) {
                const lineEnd = command.indexOf('\n', i);
                const seg = (lineEnd === -1 ? command.slice(i) : command.slice(i, lineEnd)).replace(/\r$/, '');
                i = lineEnd === -1 ? n : lineEnd + 1;
                if (lineEnd !== -1) line++;
                if (seg.trim() === delim) break;
            }
            // Here-Doc 已消费结束行换行符，必须在此收束当前命令，否则下一行首词会并入参数
            flushCmd();
            continue;
        }
        if (ch === '<' || ch === '>') {
            flushCmd();
            return { errors: [{ id: 'UnsupportedPosixRedirection', line }], commands };
        }
        if (curTokens.length === 0) curLine = line;
        let tok = '';
        while (i < n && !/[\s;|&<>]/.test(command[i])) {
            const c = command[i];
            if (c === "'") {
                i++;
                while (i < n && command[i] !== "'") {
                    if (command[i] === '\n') line++;
                    tok += command[i++];
                }
                if (i < n) i++;
            } else if (c === '"') {
                i++;
                while (i < n && command[i] !== '"') {
                    if (command[i] === '\\' && i + 1 < n) { tok += command[i + 1]; i += 2; continue; }
                    if (command[i] === '\n') line++;
                    tok += command[i++];
                }
                if (i < n) i++;
            } else if (c === '\\' && i + 1 < n) {
                tok += command[i + 1];
                i += 2;
            } else {
                tok += command[i++];
            }
        }
        if (tok) curTokens.push(tok);
    }
    flushCmd();
    return { errors: [], commands };
}

function parsePowerShellAstSync(command) {
    const cached = getCachedAst(command);
    if (cached) return cached;

    const psBin = resolvePowerShellBinary();
    if (!psBin) {
        return setCachedAst(command, parsePosixShellAst(command));
    }

    const payloadB64 = Buffer.from(command, 'utf8').toString('base64');
    const raw = execFileSync(
        psBin,
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', ENCODED_DAEMON_SCRIPT],
        {
            input: payloadB64,
            encoding: 'utf8',
            timeout: AST_WARMUP_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, VCP_AST_ONESHOT: '1' }
        }
    );
    return setCachedAst(command, normalizeAstPayload(JSON.parse(raw.trim())));
}

async function parsePowerShellAstAsync(command) {
    const cached = getCachedAst(command);
    if (cached) return cached;

    const psBin = resolvePowerShellBinary();
    if (!psBin) {
        return setCachedAst(command, parsePosixShellAst(command));
    }

    let normalized;
    try {
        normalized = await requestDaemonAst(command, psBin);
    } catch {
        shutdownAstDaemon('Retry once after daemon failure');
        normalized = await requestDaemonAst(command, psBin);
    }
    return setCachedAst(command, normalized);
}

function normalizeCommandParts(rawName) {
    const trimmed = String(rawName).trim().replace(/^['"]|['"]$/g, '');
    const afterModule = trimmed.includes('\\') && !/^[A-Za-z]:\\/i.test(trimmed) && !trimmed.startsWith('.\\') && !trimmed.startsWith('..\\')
        ? trimmed.split('\\').pop()
        : trimmed.split(/[\\/]/).pop();
    const leaf = (afterModule || trimmed).toLowerCase();
    const stem = leaf.replace(/\.(exe|com|cmd|bat|ps1|sh)$/i, '');
    return { leaf, stem };
}

function hasRecursiveForce(cmd) {
    if (cmd.params.some((p) => p === 'r' || p === 'rf' || p === 'fr' || p.startsWith('rec'))) return true;
    return cmd.subArgs.some((a) => /^(-rf|-fr|-r|\/s)$/i.test(a));
}

function evaluateAstRules(ast, forbiddenKeywords = [], authRequiredKeywords = []) {
    const result = {
        isForbidden: false,
        needsAuth: false,
        matchedKeyword: null,
        reason: null,
        ruleId: null,
        line: null
    };

    const forbiddenSet = new Set((forbiddenKeywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));
    const authSet = new Set((authRequiredKeywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));

    const markAuth = (keyword, ruleId, line, reason) => {
        if (!result.needsAuth) {
            result.needsAuth = true;
            result.matchedKeyword = keyword;
            result.ruleId = ruleId;
            result.line = line;
            result.reason = reason;
        }
    };

    for (const cmd of ast.commands) {
        if (!cmd.name) {
            markAuth('dynamic-call', 'L1_DYNAMIC_INVOCATION', cmd.line, `第 ${cmd.line} 行存在未静态绑定的动态命令调用，需授权确认`);
            continue;
        }

        const { leaf, stem } = normalizeCommandParts(cmd.name);

        if (BUILTIN_L2_DISK_COMMANDS.has(stem)) {
            return {
                isForbidden: true,
                needsAuth: false,
                matchedKeyword: stem,
                ruleId: 'L2_DISK_DESTRUCTIVE',
                line: cmd.line,
                reason: `第 ${cmd.line} 行命中磁盘/分区高危红线命令: ${stem}`
            };
        }

        if (stem === 'diskutil' && cmd.subArgs.some((a) => MAC_DISKUTIL_DESTRUCTIVE_VERBS.has(a.toLowerCase()))) {
            return {
                isForbidden: true,
                needsAuth: false,
                matchedKeyword: 'diskutil',
                ruleId: 'L2_MAC_DISKUTIL_DESTRUCTIVE',
                line: cmd.line,
                reason: `第 ${cmd.line} 行命中 macOS diskutil 抹盘/分区红线命令`
            };
        }

        if (DELETE_COMMAND_STEMS.has(stem) && cmd.targetsRoot && hasRecursiveForce(cmd)) {
            return {
                isForbidden: true,
                needsAuth: false,
                matchedKeyword: stem,
                ruleId: 'L2_ROOT_WIPE',
                line: cmd.line,
                reason: `第 ${cmd.line} 行命中根目录递归删除红线: ${stem}`
            };
        }

        if (stem === 'cmd' && cmd.subArgs.some((a) => /^\/[ck]$/i.test(a))) {
            const subCmdLine = cmd.subArgs.filter((a) => !/^\/[ck]$/i.test(a)).join(' ').trim();
            const firstSubToken = subCmdLine.split(/\s+/)[0] || '';
            if (firstSubToken) {
                const subParts = normalizeCommandParts(firstSubToken);
                if (BUILTIN_L2_DISK_COMMANDS.has(subParts.stem) || forbiddenSet.has(subParts.stem) || forbiddenSet.has(subParts.leaf)) {
                    const hit = forbiddenSet.has(subParts.leaf) ? subParts.leaf : subParts.stem;
                    return {
                        isForbidden: true,
                        needsAuth: false,
                        matchedKeyword: hit,
                        ruleId: 'L2_CMD_SUBSHELL_FORBIDDEN',
                        line: cmd.line,
                        reason: `第 ${cmd.line} 行 cmd 子壳包含禁止执行的命令: ${hit}`
                    };
                }
            }
        }

        if (SAFE_DISPLAY_CMDLETS.has(stem) && !forbiddenSet.has(stem) && !authSet.has(stem)) {
            continue;
        }

        if (forbiddenSet.has(stem) || forbiddenSet.has(leaf)) {
            const hit = forbiddenSet.has(leaf) ? leaf : stem;
            return {
                isForbidden: true,
                needsAuth: false,
                matchedKeyword: hit,
                ruleId: 'L2_FORBIDDEN_COMMAND',
                line: cmd.line,
                reason: `第 ${cmd.line} 行调用了被禁止的命令节点: ${hit}`
            };
        }

        if (DYNAMIC_EXEC_STEMS.has(stem)) {
            markAuth(stem, 'L1_DYNAMIC_IEX', cmd.line, `第 ${cmd.line} 行动态表达式执行 (${stem}) 需要授权确认`);
            continue;
        }

        if (cmd.hasRunAs) {
            markAuth('runas', 'L1_ELEVATION_RUNAS', cmd.line, `第 ${cmd.line} 行包含提权调用，需要授权确认`);
        }

        if (SHELL_ENGINE_STEMS.has(stem) && cmd.params.some((p) => ENCODED_CMD_FLAGS.has(p))) {
            markAuth('encodedcommand', 'L1_ENCODED_COMMAND', cmd.line, `第 ${cmd.line} 行包含 EncodedCommand 编码载荷，需要授权确认`);
        }

        if (authSet.has(stem) || authSet.has(leaf)) {
            const hit = authSet.has(leaf) ? leaf : stem;
            markAuth(hit, 'L1_AUTH_REQUIRED_COMMAND', cmd.line, `第 ${cmd.line} 行命令需要交互式授权: ${hit}`);
        }
    }

    if (!result.isForbidden && ast.errors.length > 0) {
        const firstErr = ast.errors[0];
        markAuth('syntax-error', 'L1_AST_SYNTAX_ERROR', firstErr.line, `第 ${firstErr.line} 行存在语法解析错误 (${firstErr.id})，需授权确认`);
    }

    return result;
}

function buildAstUnavailableResult() {
    return {
        isForbidden: false,
        needsAuth: true,
        matchedKeyword: 'ast-parse-timeout',
        ruleId: 'L1_AST_UNAVAILABLE',
        line: null,
        reason: 'AST 语法树解析超时或不可用，已转为交互式授权确认'
    };
}

function intelligentSecurityCheck(command, forbiddenKeywords = [], authRequiredKeywords = []) {
    if (typeof command !== 'string' || !command.trim()) {
        return { isForbidden: false, needsAuth: false, matchedKeyword: null, reason: null, ruleId: null, line: null };
    }
    try {
        const ast = parsePowerShellAstSync(command);
        return evaluateAstRules(ast, forbiddenKeywords, authRequiredKeywords);
    } catch {
        return buildAstUnavailableResult();
    }
}

async function intelligentSecurityCheckAsync(command, forbiddenKeywords = [], authRequiredKeywords = []) {
    if (typeof command !== 'string' || !command.trim()) {
        return { isForbidden: false, needsAuth: false, matchedKeyword: null, reason: null, ruleId: null, line: null };
    }
    try {
        const ast = await parsePowerShellAstAsync(command);
        return evaluateAstRules(ast, forbiddenKeywords, authRequiredKeywords);
    } catch {
        return buildAstUnavailableResult();
    }
}

module.exports = {
    intelligentSecurityCheck,
    intelligentSecurityCheckAsync,
    parsePowerShellAst: parsePowerShellAstSync,
    parsePowerShellAstAsync,
    parsePosixShellAst,
    shutdownAstDaemon,
    normalizeCommandParts
};