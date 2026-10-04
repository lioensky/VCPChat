'use strict';
// 工具审批等待期间，服务端不往聊天流里写任何数据（心跳只在模型输出时有），
// 群聊的块间看门狗会把「正在等人点允许」的回复当成僵死熔断：回复被丢掉，工具却在批准后照样执行。
// main.js 把 VCPLog 的审批请求、渲染端发出的审批回应转到这里；某个助手还有审批挂着时，看门狗只续期不熔断。

// 服务端审批默认 5 分钟超时；没收到回应（例如在别的客户端批了）的记录最多挂这么久
const MAX_HOLD_MS = 15 * 60 * 1000;

const pending = new Map(); // requestId → { maid, at }

const normalizeName = (name) => String(name ?? '').trim().toLowerCase();

function noteToolApprovalMessage(message, now = Date.now()) {
    const data = message && typeof message.data === 'object' && message.data ? message.data : {};
    const requestId = data.requestId;
    if (!requestId) return;
    if (message.type === 'tool_approval_request') {
        pending.set(requestId, { maid: normalizeName(data.maid), at: now });
    } else if (message.type === 'tool_approval_response') {
        pending.delete(requestId);
    }
}

/** 这个助手是否有审批在等人处理；审批没写 maid 时无法区分是谁的，按都在等处理。 */
function isWaitingForToolApproval(agentName, now = Date.now()) {
    const name = normalizeName(agentName);
    let waiting = false;
    for (const [requestId, entry] of pending) {
        if (now - entry.at > MAX_HOLD_MS) {
            pending.delete(requestId);
            continue;
        }
        if (!entry.maid || entry.maid === name) waiting = true;
    }
    return waiting;
}

function clearToolApprovals() {
    pending.clear();
}

// 看门狗用字符串原因 abort（'chunk_idle_timeout'），reader 抛出的就是这个字符串，没有 .message；用户中止不带原因，抛的是 AbortError
function isWatchdogAbort(streamError, controller) {
    return typeof streamError === 'string' || (controller.signal.aborted && typeof controller.signal.reason === 'string' && streamError?.name !== 'AbortError');
}

/** 熔断时已收到的内容（可能含已执行的工具调用和结果）要留下，并写清楚为什么停了。 */
function withWatchdogNote(content, idleMs) {
    const note = `[System Message] 连续 ${Math.round(idleMs / 1000)} 秒没有收到 VCP 的数据，这一轮回复已中止${content ? '，上面是已收到的部分' : ''}。`;
    return content ? `${content}\n\n${note}` : note;
}

module.exports = { noteToolApprovalMessage, isWaitingForToolApproval, clearToolApprovals, isWatchdogAbort, withWatchdogNote, MAX_HOLD_MS };
