// modules/chat/contextCompactionContinuity.js

/**
 * Open-issue continuity audit between consecutive checkpoints.
 *
 * forge-context keeps open issues in a ledger with an explicit lifecycle
 * (openIssues / supersededOpenIssues). Checkpoints here are plain prose, so
 * this audit is the host-owned echo of that idea: the previous checkpoint's
 * open-issue windows (❓ pending questions, ⏭️ promised next actions) are
 * located, and two signals are recorded —
 *
 *   structural: the new checkpoint carries no open-issue marker at all
 *               (issues may legitimately have been resolved; not a defect);
 *   anchors:    identifiers inside those windows that vanished from the new
 *               checkpoint (same substring standard as the fidelity audit).
 *
 * Pure functions, no model calls. Signals are metadata, never refusals.
 */

import { extractAnchors } from './contextCompactionFidelity.js';

const OPEN_MARKER_PATTERN = /❓|⏭|悬而未决|待确认|下一步/u;
const MISSING_SAMPLE_CAP = 8;

/**
 * A window starts at a marked line (open-question / next-action bullet) and
 * ends at the first blank line or markdown heading afterwards. Each marked
 * line opens its own window, so sibling bullets stay separate reports.
 * @param {string} checkpointText
 * @returns {string[]}
 */
export function extractOpenIssueWindows(checkpointText) {
    if (typeof checkpointText !== 'string' || !checkpointText) return [];
    const lines = checkpointText.split(/\r?\n/);
    const windows = [];
    let buffer = null;
    const flush = () => {
        if (buffer && buffer.length) windows.push(buffer.join('\n'));
        buffer = null;
    };
    for (const line of lines) {
        const trimmed = line.trim();
        if (OPEN_MARKER_PATTERN.test(trimmed)) {
            flush();
            buffer = [line];
            continue;
        }
        if (buffer) {
            if (!trimmed || /^#{1,4}\s/.test(trimmed) || trimmed.startsWith('</context_checkpoint>')) {
                flush();
                continue;
            }
            buffer.push(line);
        }
    }
    flush();
    return windows;
}

/**
 * @param {string|null} previousCheckpoint raw checkpoint text of the previous compaction
 * @param {string} nextCheckpoint the newly returned checkpoint report
 * @returns {{applicable: boolean, windows: number, openIssuesDropped: boolean,
 *            anchors: {total: number, preserved: number, missing: string[]}, note: string}}
 */
export function auditCheckpointContinuity(previousCheckpoint, nextCheckpoint) {
    const previous = typeof previousCheckpoint === 'string' ? previousCheckpoint : '';
    const next = typeof nextCheckpoint === 'string' ? nextCheckpoint : '';
    const result = {
        applicable: Boolean(previous),
        windows: 0,
        openIssuesDropped: false,
        anchors: { total: 0, preserved: 0, missing: [] },
        note: '未决项延续审计：结构缺失可能代表问题已被解决；锚点缺失沿用保真审计的子串标准。信号仅供人工核对，不作为拒收依据。',
    };
    if (!result.applicable) return result;
    const windows = extractOpenIssueWindows(previous);
    result.windows = windows.length;
    if (!windows.length) return result;
    // Structural signal: the new report carries no open-issue marker anywhere.
    result.openIssuesDropped = !OPEN_MARKER_PATTERN.test(next);
    // Anchor signal: identifiers inside open-issue windows must survive
    // into the new checkpoint (hash matching is case-insensitive, like fidelity).
    const nextLower = next.toLowerCase();
    const seen = new Set();
    for (const window of windows) {
        for (const [kind, anchors] of extractAnchors(window)) {
            for (const anchor of anchors) {
                if (seen.has(anchor)) continue;
                seen.add(anchor);
                result.anchors.total += 1;
                const hit = kind === 'hash'
                    ? nextLower.includes(anchor)
                    : next.includes(anchor);
                if (hit) result.anchors.preserved += 1;
                else if (result.anchors.missing.length < MISSING_SAMPLE_CAP) result.anchors.missing.push(anchor);
            }
        }
    }
    return result;
}
