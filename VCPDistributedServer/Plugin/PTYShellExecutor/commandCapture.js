'use strict';

const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

/**
 * 构建 POSIX 环境下在共享 Shell (bash/zsh) 中运行的捕获包装脚本。
 * 1. 在当前 Shell 中 dot-source 脚本，完整保留 cd 目录与环境变量；
 * 2. 通过 exec 描述符直接同步将输出重定向至目标 outputPath 日志；
 * 3. 恢复描述符后将日志 cat 回终端供 xterm/侧栏和 QueryVisible 审计；
 * 4. 采用 head -c 实现 256KB 截断保护，原子化落盘 receipt.json 完成凭据。
 */
function buildCaptureWrapper({ scriptPath, outputPath, receiptPath, runId, maxBytes = 262144 }) {
    const escapedScript = quote(scriptPath);
    const escapedOutput = quote(outputPath);
    const escapedReceipt = quote(receiptPath);
    const escapedPendingReceipt = quote(receiptPath + '.pending');

    return `#!/usr/bin/env bash
export PAGER='cat'
export GIT_PAGER='cat'
export GIT_TERMINAL_PROMPT='0'
export SYSTEMD_PAGER='cat'
export MANPAGER='cat'

_vcp_start_ms=$(date +%s%3N 2>/dev/null)
if [ -z "$_vcp_start_ms" ] || [ \${#_vcp_start_ms} -le 10 ]; then
    _vcp_start_ms=$(($(date +%s) * 1000))
fi

rm -f ${escapedOutput} 2>/dev/null || true
touch ${escapedOutput} 2>/dev/null || true

# 1. 采用复合命令块直接重定向，确保在语句块退出时立刻关闭文件描述符并完整刷盘
{
    . ${escapedScript}
} > ${escapedOutput} 2>&1
_vcp_exit=$?

# 2. 将捕获到的完整输出打印回终端，以供前端 xterm/侧栏与 QueryVisible 感知
if [ -s ${escapedOutput} ]; then
    cat ${escapedOutput}
fi
_vcp_end_ms=$(date +%s%3N 2>/dev/null)
if [ -z "$_vcp_end_ms" ] || [ \${#_vcp_end_ms} -le 10 ]; then
    _vcp_end_ms=$(($(date +%s) * 1000))
fi
_vcp_duration=$((_vcp_end_ms - _vcp_start_ms))
if [ $_vcp_duration -lt 0 ]; then
    _vcp_duration=0
fi

# 3. 截断保护：如果超过容量上限，保留前 maxBytes 字节
_vcp_truncated=false
if [ -f ${escapedOutput} ]; then
    _vcp_bytes=$(wc -c < ${escapedOutput} 2>/dev/null || echo 0)
    if [ "$_vcp_bytes" -gt ${maxBytes} ]; then
        _vcp_tmp="${escapedOutput}.trunc"
        head -c ${maxBytes} ${escapedOutput} > "$_vcp_tmp" 2>/dev/null && mv -f "$_vcp_tmp" ${escapedOutput}
        _vcp_truncated=true
    fi
fi

_vcp_terminating=false
if [ "$_vcp_exit" -ge 126 ]; then
    _vcp_terminating=true
fi

_vcp_errors=0
if [ "$_vcp_exit" -ne 0 ]; then
    _vcp_errors=1
fi

# 4. 原子写入结构化完成回执
cat <<RECEIPT_EOF > ${escapedPendingReceipt}
{
  "version": 1,
  "runId": "${runId}",
  "executionState": "completed",
  "errorCount": $_vcp_errors,
  "terminatingError": $_vcp_terminating,
  "nativeExitCode": $_vcp_exit,
  "durationMs": $_vcp_duration,
  "truncated": $_vcp_truncated
}
RECEIPT_EOF

mv -f ${escapedPendingReceipt} ${escapedReceipt} 2>/dev/null || true
`;
}

function parseCaptureReceipt(text, runId) {
    let receipt;
    try {
        receipt = JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON in completion receipt: ${e.message}`);
    }
    if (receipt.version !== 1 || receipt.runId !== runId ||
        receipt.executionState !== 'completed' ||
        !Number.isInteger(receipt.errorCount) || receipt.errorCount < 0 ||
        typeof receipt.terminatingError !== 'boolean' ||
        typeof receipt.truncated !== 'boolean' ||
        !Number.isFinite(receipt.durationMs) || receipt.durationMs < 0 ||
        !(receipt.nativeExitCode === null || Number.isInteger(receipt.nativeExitCode))) {
        throw new Error('Invalid POSIX Shell completion receipt format');
    }
    return receipt;
}

module.exports = { buildCaptureWrapper, parseCaptureReceipt };