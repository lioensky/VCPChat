const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs-extra');

const execFileAsync = promisify(execFile);

function bridgeRootPath() {
    return process.env.VCP_BRIDGE_ROOT
        ? path.resolve(process.env.VCP_BRIDGE_ROOT)
        : path.resolve(__dirname, '..', '..', '..', 'VCPBridge');
}

function bridgeScriptPath() {
    return path.join(bridgeRootPath(), 'scripts', 'codex_vcp_bridge.py');
}

function bridgeTempDir() {
    return path.join(bridgeRootPath(), 'tmp');
}

async function requestCodexRelayReply({ groupId, topicId, bridgeSessionId, requestText, messageId }) {
    const request = [
        `VCPChat group=${groupId} topic=${topicId} message=${messageId}`,
        requestText || ''
    ].join('\n');
    const requestFile = path.join(bridgeTempDir(), `codex-relay-request-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    try {
        await fs.ensureDir(path.dirname(requestFile));
        await fs.writeFile(requestFile, request, 'utf8');
        const result = await execFileAsync('python', [
            bridgeScriptPath(),
            'request-codex-reply',
            '--bridge-session-id',
            String(bridgeSessionId || 'ancheng_vcp_meeting_default'),
            '--thread-label',
            'vcp-dedicated-current-thread',
            '--requester',
            'VCPChat AI设计师 Codex relay',
            '--request-message-id',
            String(messageId || ''),
            '--origin-group-id',
            String(groupId || ''),
            '--origin-topic-id',
            String(topicId || ''),
            '--request-file',
            requestFile
        ], {
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 1024 * 1024
        });

        let payload = {};
        try {
            payload = JSON.parse(String(result.stdout || '{}'));
        } catch (parseError) {
            console.warn('[CodexRelayClient] response was not valid JSON:', parseError);
        }

        return {
            ok: true,
            content: typeof payload.content === 'string' ? payload.content : '',
            shouldShowThinking: payload.should_show_thinking === true,
            relayMode: payload.relay_mode || 'projection_only',
            status: payload.status || 'recorded',
            workerStatus: payload.worker_status || 'offline',
            jobId: payload.job?.job_id || '',
            codexspace: payload.codexspace || {}
        };
    } catch (error) {
        console.error('[CodexRelayClient] request failed:', error);
        return {
            ok: false,
            shouldShowThinking: false,
            content: `[CodexBridge 错误] 已收到消息，但创建 Codex 回复请求失败：${error.message}`
        };
    } finally {
        fs.remove(requestFile).catch(() => {});
    }
}

module.exports = {
    bridgeRootPath,
    requestCodexRelayReply
};
