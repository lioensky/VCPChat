'use strict';

const { MAX_SLEEP_MS } = require('./sleepStreamIdle');
const MAX_SCAN_CHARS = 1024 * 1024;
const SLEEP_FIELDS = ['睡觉时间', 'sleeptime', 'duration', 'durationseconds', 'seconds'];
const UNIT_MS = {
    ms: 1, 毫秒: 1, s: 1000, 秒: 1000, m: 60_000, min: 60_000, 分钟: 60_000,
    h: 3_600_000, hr: 3_600_000, 小时: 3_600_000,
};
const JEV_SLEEP = /^(?:请(?:帮我)?|帮我)?\s*(?:进入睡眠|睡眠|睡一觉|打个盹|打盹|等待回调|等候回调|休眠)\s*\[([^[]+?)\]/;
let scannerPromise;

function parseSleepMs(value) {
    const input = value?.trim().toLowerCase() || '';
    const single = /^(\d+(?:\.\d+)?)(?:\s*(ms|毫秒|s|秒|m|min|分钟|h|hr|小时))?$/.exec(input);
    const parts = single ? null : /^(?:(\d+(?:\.\d+)?)\s*(?:小时|h|hr))?\s*(?:(\d+(?:\.\d+)?)\s*(?:分钟|min|m))?\s*(?:(\d+(?:\.\d+)?)\s*(?:秒|s))?$/.exec(input);
    const ms = Math.round(single
        ? Number(single[1]) * UNIT_MS[single[2] || 's']
        : parts ? (Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0)) * 1000 : 0);
    return ms > 0 && ms <= MAX_SLEEP_MS ? ms : 0;
}

async function createSleepStreamRequests(idle) {
    const { replaceToolRequestBlocks, readToolRequestField } =
        await (scannerPromise ??= import('../renderer/toolRequestScanner.js'));
    let text = '';
    let seenThrough = 0;
    let sleepEnd = 0;

    return function observe(delta) {
        if (typeof delta !== 'string' || delta.length === 0 || text === null) return;
        const previousLength = text.length;
        if (previousLength + delta.length > MAX_SCAN_CHARS) {
            text = null;
            idle.resume();
            return;
        }
        text += delta;
        let pending = null;
        // Scan only on a newly arrived boundary, including markers split across chunks.
        if (/\[END_TOOL_REQUEST\]>{2,4}/i.test(text.slice(Math.max(0, previousLength - 24)))) {
            replaceToolRequestBlocks(text, (block, source, start, end, scan) => {
                if (end <= seenThrough) return block;
                seenThrough = end;
                const linePrefix = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
                if (scan.field?.recoveredFromUnclosedField || /^\s*>/.test(linePrefix)
                    || readToolRequestField(source, 'timely_contact')) return block;
                const tool = readToolRequestField(source, 'tool_name')?.toLowerCase();
                const jev = readToolRequestField(source, 'jev');
                const value = jev !== null ? JEV_SLEEP.exec(jev)?.[1]
                    : tool === 'vcpsleep'
                        ? SLEEP_FIELDS.map(name => readToolRequestField(source, name)).find(field => field !== null)
                        : null;
                const ms = parseSleepMs(value);
                if (ms && (!pending || ms > pending)) pending = ms;
                return block;
            });
        }
        if (pending) {
            idle.sleep(pending);
            sleepEnd = seenThrough;
        }
        // Whitespace/SSE keepalives do not mean generation resumed. Visible content
        // after the call (including its returned tool data) restores the usual budget.
        if (sleepEnd && /[\p{L}\p{N}]/u.test(text.slice(sleepEnd))) {
            sleepEnd = 0;
            idle.resume();
        }
    };
}

module.exports = { createSleepStreamRequests, parseSleepMs };