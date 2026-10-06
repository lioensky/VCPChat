/**
 * modules/ui-system/side-pane/modelTrajectorySideProvider.js
 * VCPChat Universal Sub-screen - 调用轨迹 Provider
 *
 * 对应 ZCode 的「模型调用轨迹」标签
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/ModelTrajectoryPane.tsx / ModelTrajectoryPaneParts.tsx /
 * ModelTrajectoryExpandableMessage.tsx / ModelTrajectoryExpandedContent.tsx / ModelTrajectorySearchBar.tsx / ModelTrajectoryExpansionMenu.tsx）：
 * 头部汇总（N 次调用 · token · 模型）、搜索（上一个 / 下一个 / 命中数 / 高亮）、按角色的展开开关、全部展开 / 收起、
 * 每次调用一张卡片（序号、来源、结束原因、IN / OUT / 耗时 / 时间），卡片里是输入（只列新增的）、输出（思考 / 回答 / 工具调用）和错误块，
 * 每条消息可折叠、可复制，超长内容裁到 256px 并给「展开」。
 * 数据来自主进程的调用轨迹记录器（modules/modelTrajectory.js），跟随主聊天当前的话题；调用开始 / 结束时实时刷新。
 * 与原实现不同的地方：没有用虚拟列表库，而是卡片懒构建——每张卡片先只有标题栏和占位高度，
 * 滚到可视区附近（IntersectionObserver）、被搜索命中或被定位时才生成里面的消息行，屏外绘制再由 content-visibility 跳过；
 * 数据整理见 modelTrajectoryModel.js（工具调用 / 结果从 VCP 文本协议里还原）。
 */

'use strict';

import { pollWhileVisible } from './side-pane-occurrence.js';
import {
    ROLE_LABELS, formatClockTime, formatDateTime, formatDuration, finishReasonLabel, effectiveFinishReason, sourceLabel,
    buildTimeline, summarizeRecords, buildSearchIndex, findTextMatches,
    inputRowKey, outputRowKey, messagePreview, messageContent, toolMetadata, toolHasError, toolOutputs, toolCallInputs,
    visualRoleOf, formatToolPayload
} from './modelTrajectoryModel.js';

const TAB_ID = 'model-trajectory:main';
const FOLLOW_THRESHOLD_PX = 40;
const FOLLOW_POLL_MS = 3000;
const RELOAD_DEBOUNCE_MS = 80;
const SEARCH_DEBOUNCE_MS = 120;
/** 卡片进入可视区上下这么远时就提前构建，滚动时不露出占位。 */
const BUILD_MARGIN = '600px 0px';
/** 打开 / 刷新时同步构建的末尾卡片数，滚到底部时看到的就是完整内容。 */
const EAGER_TAIL_CARDS = 3;
const HIGHLIGHT = 'vcp-trajectory-find';
const HIGHLIGHT_ACTIVE = 'vcp-trajectory-find-active';

export const EXPANSION_KINDS = Object.freeze(['system', 'user', 'reasoning', 'assistant', 'tool-call', 'tool-result']);
const EXPANSION_LABELS = Object.freeze({
    system: ROLE_LABELS.system, user: ROLE_LABELS.user, reasoning: '思考过程', assistant: ROLE_LABELS.assistant, 'tool-call': '工具调用', 'tool-result': ROLE_LABELS.tool
});

export const modelTrajectoryTabId = () => TAB_ID;

/** 与主进程 sessionKeyFromContext 一致：群聊用群 id，否则用智能体 id，再接话题 id。 */
export function trajectoryKeyFor(conversation) {
    const itemId = conversation?.item?.id;
    const topicId = conversation?.topicId;
    return itemId && topicId ? `${itemId}__${topicId}` : null;
}

export function createModelTrajectorySideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    uiHelper = null,
    getConversation = () => null,
    onConversationChange = null
} = {}) {
    const kind = 'model-trajectory';
    const win = doc.defaultView || window;
    const toast = (message, type = 'info') => uiHelper?.showToastNotification?.(message, type);
    /** @type {Set<{focusCall: (requestId: string) => void}>} */
    const instances = new Set();
    let requestedRequestId = null;

    return {
        kind,

        /** 打开（或聚焦）调用轨迹标签；带 requestId（消息 id）时滚动到对应的那次调用。 */
        async openModelTrajectoryTab({ requestId = null } = {}) {
            if (!sidePaneController) return null;
            requestedRequestId = requestId;
            const handle = await sidePaneController.openTab({
                id: TAB_ID,
                kind,
                title: '调用轨迹',
                icon: 'monitoring',
                closable: true,
                scopeMode: 'global',
                searchHint: '模型调用 请求 响应 token 轨迹'
            });
            sidePaneController.setVisible?.(true);
            if (requestId) for (const instance of instances) instance.focusCall(requestId);
            handle?.focus?.();
            return handle;
        },

        async mountTab(tab, viewElement, { scope: viewScope = null, occurrence = null } = {}) {
            if (!viewElement) return null;
            viewElement.innerHTML = '';
            viewElement.classList.add('side-traj-view');

            const h = (tag, className, text) => {
                const node = doc.createElement(tag);
                if (className) node.className = className;
                if (text !== undefined && text !== null) node.textContent = text;
                return node;
            };
            const icon = (name, className = '') => {
                const node = h('span', `vcp-ui-icon ${className}`.trim(), name);
                node.setAttribute('aria-hidden', 'true');
                return node;
            };
            const iconButton = (name, label, onClick, className = '') => {
                const btn = h('button', `side-traj-icon-btn ${className}`.trim());
                btn.type = 'button';
                btn.title = label;
                btn.setAttribute('aria-label', label);
                btn.appendChild(icon(name));
                if (onClick) btn.addEventListener('click', onClick);
                return btn;
            };

            // ---------------------------------------------------------------- 状态
            let sessionKey = null;
            let conversationLabel = '';
            let data = { records: [], truncated: false, total: 0 };
            let items = [];
            let loading = false;
            let loadError = '';
            let disposed = false;
            let loadSeq = 0;
            let reloadTimer = null;
            let searchTimer = null;
            let unsubscribe = null;
            let unwatch = null; // 主进程那份推送的计数，dispose 时退掉
            let unsubscribeConversation = null;
            let poller = null;
            let focusRequestId = requestedRequestId;
            let searchOpen = false;
            let searchQuery = '';
            let searchIndex = { query: '', matches: [] };
            let searchActive = 0;
            let highlightFrame = 0;
            let version = 0;
            let commands = Object.fromEntries(EXPANSION_KINDS.map(name => [name, { expanded: true, version: 0 }]));
            /** @type {Map<string, {open: boolean, commandVersion: number}>} 用户手动展开 / 收起过的行 */
            let overrides = new Map();
            /** @type {Map<string, {el: HTMLElement, sig: string, rows: Array<{key: string, update: () => void}>, built: boolean, ensure: () => boolean}>} */
            let cardCache = new Map();
            let stickToBottom = true;
            /** @type {Map<string, {update: () => void}>} */
            let rowRegistry = new Map();
            const hasHighlights = Boolean(win.CSS?.highlights && win.Highlight);

            // ---------------------------------------------------------------- 骨架
            const scope = h('div', 'zc-scope vcp-ui-scope side-traj-scope');
            const header = h('div', 'side-traj-header');
            const titleRow = h('div', 'side-traj-title-row');
            const title = h('span', 'side-traj-title', '模型调用轨迹');
            const subtitle = h('span', 'side-traj-subtitle');
            const titleWrap = h('div', 'side-traj-title-wrap');
            titleWrap.append(title, subtitle);
            const searchBtn = iconButton('search', '搜索调用轨迹', () => openSearch());
            const menuBtn = iconButton('tune', '自定义展开', event => { event.stopPropagation(); toggleMenu(); });
            const toggleAllBtn = iconButton('maximize_2', '全部收起', () => toggleAll());
            const folderBtn = iconButton('folder_open', '打开记录目录', () => { void openDirectory(); });
            const clearBtn = iconButton('delete', '清空这个话题的调用轨迹', () => { void clearAll(); });
            const refreshBtn = iconButton('refresh', '刷新', () => { void load(); });
            const actions = h('div', 'side-traj-actions');
            actions.append(searchBtn, menuBtn, toggleAllBtn, folderBtn, clearBtn, refreshBtn);
            titleRow.append(titleWrap, actions);

            const summaryLine = h('div', 'side-traj-summary');
            const searchBar = h('div', 'side-traj-search');
            searchBar.hidden = true;
            const searchInput = h('input', 'side-traj-search-input');
            searchInput.type = 'search';
            searchInput.placeholder = '搜索调用轨迹内容…';
            searchInput.setAttribute('aria-label', '搜索调用轨迹');
            const searchCount = h('span', 'side-traj-search-count', '0/0');
            const searchPrev = iconButton('arrow_upward', '上一个匹配项', () => moveSearch(-1));
            const searchNext = iconButton('arrow_downward', '下一个匹配项', () => moveSearch(1));
            const searchClose = iconButton('close', '关闭搜索', () => closeSearch());
            searchBar.append(icon('search', 'side-traj-search-glyph'), searchInput, searchCount, searchPrev, searchNext, searchClose);
            header.append(titleRow, summaryLine, searchBar);

            const menu = h('div', 'side-traj-menu');
            menu.hidden = true;
            menu.setAttribute('role', 'menu');

            const scroller = h('div', 'side-traj-scroll');
            const state = h('div', 'side-traj-state');
            const timeline = h('ol', 'side-traj-timeline');
            const truncatedNotice = h('p', 'side-traj-truncated', '记录过多，仅展示最近的调用');
            truncatedNotice.hidden = true;
            scroller.append(state, timeline, truncatedNotice);
            scope.append(header, menu, scroller);
            viewElement.appendChild(scope);

            // 卡片懒构建：没有 IntersectionObserver（比如测试环境）时退回一次全部构建
            const buildObserver = typeof win.IntersectionObserver === 'function'
                ? new win.IntersectionObserver((entries) => {
                    let builtAny = false;
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        buildObserver.unobserve(entry.target);
                        const card = cardCache.get(entry.target.dataset.trajectoryCall);
                        if (card?.ensure()) builtAny = true;
                    }
                    if (!builtAny) return;
                    if (stickToBottom && !doc.hidden) scroller.scrollTop = scroller.scrollHeight;
                    if (searchIndex.query) scheduleHighlights();
                }, { root: scroller, rootMargin: BUILD_MARGIN })
                : null;
            scroller.addEventListener('scroll', () => {
                stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_THRESHOLD_PX;
            }, { passive: true });

            // ---------------------------------------------------------------- 展开状态（command / override 版本号）
            const rowOpen = (visualRole, expansionKey) => {
                const command = commands[visualRole];
                const override = overrides.get(expansionKey) || { open: true, commandVersion: 0 };
                const userOpen = command && command.version > override.commandVersion ? command.expanded : override.open;
                return { open: userOpen || revealedKey() === expansionKey, revealed: revealedKey() === expansionKey };
            };
            const revealedKey = () => (searchIndex.matches[clampActive()]?.expansionKey) || null;
            const clampActive = () => (searchIndex.matches.length === 0 ? -1 : Math.min(searchActive, searchIndex.matches.length - 1));

            const updateAllRows = () => { for (const row of rowRegistry.values()) row.update(); };

            // ---------------------------------------------------------------- 行
            function createRow({ expansionKey, message, role, visualRole: forcedRole, roleLabel, record, alt }) {
                const visualRole = visualRoleOf(message, forcedRole);
                const metadata = toolMetadata(message);
                const hasError = toolHasError(message);
                const isToolPayload = message.parts.some(part => part.kind === 'tool-result' || part.kind === 'tool-call');
                const payloadLabel = message.parts.some(part => part.kind === 'tool-result') ? '输出' : message.parts.some(part => part.kind === 'tool-call') ? '输入' : '';

                const row = h('div', `side-traj-row role-${visualRole}${alt ? ' alt' : ''}`);
                row.dataset.trajectorySearchTargetKey = expansionKey;
                row.dataset.trajectoryRole = visualRole;

                const head = h('div', 'side-traj-row-head');
                head.setAttribute('role', 'button');
                head.tabIndex = 0;
                const chevron = icon('chevron_right', 'side-traj-chevron');
                const label = h('span', 'side-traj-role', roleLabel);
                const body = h('span', 'side-traj-row-main');
                if (payloadLabel) {
                    const direction = h('span', `side-traj-direction${hasError ? ' error' : ''}`, `${hasError ? '! ' : ''}${payloadLabel}`);
                    body.appendChild(direction);
                }
                const preview = h('span', 'side-traj-preview', messagePreview(message));
                preview.dataset.trajectorySearchField = 'content';
                body.appendChild(preview);
                if (metadata.names) {
                    const badge = h('span', 'side-traj-badge', metadata.names);
                    badge.dataset.trajectorySearchField = 'tool-name';
                    badge.title = metadata.names;
                    body.appendChild(badge);
                }
                if (metadata.ids) {
                    const badge = h('span', 'side-traj-badge side-traj-badge-id', metadata.ids);
                    badge.dataset.trajectorySearchField = 'tool-id';
                    badge.title = metadata.ids;
                    body.appendChild(badge);
                }
                const meta = h('span', 'side-traj-row-meta', formatClockTime(record.startedAt));
                meta.title = formatDateTime(record.startedAt);
                const copyText = messageContent(message);
                const copyBtn = iconButton('content_copy', '复制内容', async event => {
                    event.stopPropagation();
                    try {
                        await win.navigator.clipboard.writeText(copyText);
                        toast('已复制', 'success');
                    } catch (_error) {
                        toast('复制失败', 'error');
                    }
                }, 'side-traj-row-copy');
                copyBtn.disabled = !copyText;
                head.append(chevron, label, body, meta, copyBtn);

                const expanded = h('div', 'side-traj-expanded');
                const shell = h('div', 'side-traj-expanded-shell');
                const content = h('div', 'side-traj-content');
                const more = h('button', 'side-traj-more');
                more.type = 'button';
                more.hidden = true;
                shell.append(content, more);
                expanded.appendChild(shell);
                row.append(head, expanded);

                let built = false;
                let showAll = false;
                let measureFrame = 0;

                const build = () => {
                    built = true;
                    if (metadata.names || metadata.ids) {
                        const badges = h('div', 'side-traj-badges');
                        if (metadata.names) { const badge = h('span', 'side-traj-badge', metadata.names); badge.dataset.trajectorySearchField = 'tool-name'; badges.appendChild(badge); }
                        if (metadata.ids) { const badge = h('span', 'side-traj-badge side-traj-badge-id', metadata.ids); badge.dataset.trajectorySearchField = 'tool-id'; badges.appendChild(badge); }
                        content.appendChild(badges);
                    }
                    const payloads = message.parts.some(part => part.kind === 'tool-result') ? toolOutputs(message) : toolCallInputs(message);
                    if (isToolPayload && payloads.length) {
                        for (const payload of payloads) {
                            const pre = h('pre', `side-traj-pre${hasError ? ' error' : ''}`, payload.trim());
                            pre.dataset.trajectorySearchField = 'content';
                            content.appendChild(pre);
                        }
                        return;
                    }
                    for (const part of message.parts) {
                        const block = h('div', 'side-traj-part');
                        block.dataset.trajectorySearchField = 'content';
                        if (part.kind === 'text') {
                            if (!part.text) continue;
                            block.className = `side-traj-part side-traj-text${visualRole === 'reasoning' ? ' reasoning' : ''}`;
                            block.textContent = part.text.trim();
                        } else if (part.kind === 'image') {
                            block.className = 'side-traj-part side-traj-image';
                            block.textContent = `[image${part.mediaType ? ` · ${part.mediaType}` : ''}${part.bytes ? ` · ${Math.round(part.bytes / 1024)}KB` : ''}]`;
                        } else {
                            block.className = 'side-traj-part side-traj-pre';
                            block.textContent = formatToolPayload(part.raw ?? part);
                        }
                        content.appendChild(block);
                    }
                    if (!content.childNodes.length) content.appendChild(h('span', 'side-traj-empty-part', '—'));
                };

                const measure = () => {
                    measureFrame = 0;
                    if (!row.classList.contains('open') || showAll) return;
                    const overflowing = content.scrollHeight > content.clientHeight + 2;
                    shell.classList.toggle('overflowing', overflowing);
                    more.hidden = !overflowing || row.classList.contains('revealed');
                    more.textContent = '展开';
                };
                const scheduleMeasure = () => {
                    if (measureFrame || typeof win.requestAnimationFrame !== 'function') return;
                    measureFrame = win.requestAnimationFrame(measure);
                };
                more.addEventListener('click', () => {
                    showAll = !showAll;
                    shell.classList.toggle('show-all', showAll);
                    more.textContent = showAll ? '收起' : '展开';
                    more.hidden = false;
                });

                const update = () => {
                    const { open, revealed } = rowOpen(visualRole, expansionKey);
                    if (open && !built) build();
                    row.classList.toggle('open', open);
                    row.classList.toggle('revealed', revealed);
                    head.setAttribute('aria-expanded', String(open));
                    if (!open) { showAll = false; shell.classList.remove('show-all', 'overflowing'); more.hidden = true; }
                    else scheduleMeasure();
                    shell.classList.toggle('show-all', showAll || revealed);
                };
                const toggle = () => {
                    const command = commands[visualRole];
                    const current = overrides.get(expansionKey) || { open: true, commandVersion: 0 };
                    const open = rowOpen(visualRole, expansionKey).open;
                    overrides.set(expansionKey, { open: !open, commandVersion: command ? command.version : current.commandVersion });
                    update();
                };
                head.addEventListener('click', toggle);
                head.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
                });
                update();
                return { el: row, key: expansionKey, update };
            }

            // ---------------------------------------------------------------- 卡片
            function section(titleText, kindName) {
                const box = h('section', `side-traj-section side-traj-section-${kindName}`);
                box.appendChild(h('div', 'side-traj-section-title', titleText));
                return box;
            }

            function buildCard(item, index) {
                const { record } = item;
                const rows = [];
                const entry = { el: null, sig: '', rows, built: false, ensure: () => false };
                const card = h('li', 'side-traj-call');
                card.dataset.trajectoryCall = item.key;
                if (record.requestId) card.dataset.requestId = record.requestId;
                const status = record.status || 'completed';

                const bar = h('div', 'side-traj-call-bar');
                bar.appendChild(h('span', 'side-traj-call-index', String(index + 1).padStart(2, '0')));
                const sourceWrap = h('span', 'side-traj-call-source');
                const source = h('span', 'side-traj-call-source-title', sourceLabel(record.source));
                const agentName = record.source?.agentName;
                if (agentName) source.title = agentName;
                sourceWrap.appendChild(source);
                if (agentName && record.source?.kind !== 'title') sourceWrap.appendChild(h('span', 'side-traj-call-agent', agentName));
                if (status === 'running') {
                    const chip = h('span', 'side-traj-pill running');
                    chip.append(icon('progress_activity', 'spin'), h('span', '', '进行中'));
                    sourceWrap.appendChild(chip);
                } else if (status === 'aborted') {
                    sourceWrap.appendChild(h('span', 'side-traj-pill aborted', '已中断'));
                } else if (record.response?.finishReason) {
                    const finishReason = effectiveFinishReason(record.response);
                    const pill = h('span', 'side-traj-pill', finishReasonLabel(finishReason));
                    pill.dataset.finishReason = finishReason;
                    sourceWrap.appendChild(pill);
                }
                bar.appendChild(sourceWrap);
                const usage = record.response?.usage;
                const approx = usage?.estimated ? '≈' : '';
                const estimatedTitle = usage?.estimated ? '服务端没有返回用量，按字符数估算' : '';
                const metaParts = [];
                if (typeof usage?.inputTokens === 'number') metaParts.push({ text: `IN ${approx}${usage.inputTokens.toLocaleString()}`, title: estimatedTitle });
                if (typeof usage?.cachedInputTokens === 'number') metaParts.push({ text: `缓存 ${usage.cachedInputTokens.toLocaleString()}`, title: '输入里命中服务端提示词缓存的 token 数' });
                if (typeof usage?.outputTokens === 'number') {
                    const reasoning = typeof usage.reasoningTokens === 'number' ? `其中思考 ${usage.reasoningTokens.toLocaleString()} token` : '';
                    metaParts.push({ text: `OUT ${approx}${usage.outputTokens.toLocaleString()}`, title: [estimatedTitle, reasoning].filter(Boolean).join('；') });
                }
                if (typeof record.durationMs === 'number') metaParts.push({ text: formatDuration(record.durationMs) });
                metaParts.push({ text: formatClockTime(record.startedAt), title: formatDateTime(record.startedAt) });
                const meta = h('span', 'side-traj-call-meta');
                metaParts.forEach((entry, i) => {
                    const piece = h('span', '', `${i > 0 ? '· ' : ''}${entry.text}`);
                    if (entry.title) piece.title = entry.title;
                    meta.appendChild(piece);
                });
                bar.appendChild(meta);
                card.appendChild(bar);

                const body = h('div', 'side-traj-call-body pending');
                card.appendChild(body);
                entry.el = card;
                entry.ensure = () => {
                    if (entry.built) return false;
                    entry.built = true;
                    body.classList.remove('pending');
                    buildBody(item, record, status, body, rows);
                    for (const row of rows) rowRegistry.set(row.key, row);
                    return true;
                };
                return entry;
            }

            function buildBody(item, record, status, body, rows) {
                const omitted = record.request?.omittedMessages;
                if (omitted) body.appendChild(h('div', 'side-traj-call-note', `记录文件只读到了尾部，这次调用更早的 ${omitted} 条上下文没能还原`));
                if (item.inputMessages.length) {
                    const box = section('输入', 'input');
                    item.inputMessages.forEach((message, i) => {
                        const role = message.role;
                        const known = ROLE_LABELS[role];
                        const row = createRow({
                            expansionKey: inputRowKey(item, i), message, role,
                            roleLabel: known || role, record, alt: i % 2 === 1
                        });
                        rows.push(row);
                        box.appendChild(row.el);
                    });
                    body.appendChild(box);
                }
                if (item.outputRows.length) {
                    const box = section('输出', 'output');
                    item.outputRows.forEach((outputRow, i) => {
                        const row = createRow({
                            expansionKey: outputRowKey(item, outputRow), message: outputRow.message, role: 'assistant',
                            visualRole: outputRow.visualRole === 'reasoning' ? 'reasoning' : undefined,
                            roleLabel: outputRow.roleLabel, record, alt: (item.inputMessages.length + i) % 2 === 1
                        });
                        rows.push(row);
                        box.appendChild(row.el);
                    });
                    body.appendChild(box);
                }
                if (record.error) {
                    const block = h('div', 'side-traj-error');
                    block.setAttribute('role', 'alert');
                    block.appendChild(icon('error'));
                    const text = h('div', 'side-traj-error-text');
                    text.appendChild(h('p', 'side-traj-error-message', `${record.error.name || 'Error'}: ${record.error.message || ''}`));
                    if (record.error.stack) text.appendChild(h('pre', 'side-traj-error-stack', record.error.stack));
                    block.appendChild(text);
                    body.appendChild(block);
                }
                if (!body.childNodes.length) body.appendChild(h('div', 'side-traj-call-empty', status === 'running' ? '等待模型响应…' : '这次调用没有记录到内容'));
            }

            /** 构建某次调用的卡片内容（已构建时什么也不做）。 */
            const ensureCard = (callKey) => {
                const card = cardCache.get(callKey);
                if (!card || !card.ensure()) return card || null;
                buildObserver?.unobserve(card.el);
                return card;
            };

            const signature = (item, index) => {
                const { record } = item;
                return [index, record.status, record.endedAt || 0, record.response?.text?.length || 0, record.response?.reasoningText?.length || 0, record.response?.toolCalls?.length || 0,
                    item.inputMessages.length, record.error?.message || ''].join('|');
            };

            // ---------------------------------------------------------------- 渲染
            function renderHeader() {
                title.textContent = '模型调用轨迹';
                subtitle.textContent = conversationLabel;
                subtitle.title = sessionKey || '';
                const records = data.records;
                const has = records.length > 0;
                for (const btn of [searchBtn, menuBtn, toggleAllBtn, clearBtn]) btn.hidden = !has;
                if (!has) { menu.hidden = true; closeSearch(); }
                summaryLine.hidden = !has;
                summaryLine.textContent = '';
                if (has) {
                    const summary = summarizeRecords(records);
                    summaryLine.appendChild(h('span', '', `${records.length} 次调用`));
                    if (summary.totalTokens > 0) {
                        const tokens = h('span', 'mono', `· ${summary.estimated ? '≈' : ''}${summary.totalTokens.toLocaleString()} tok`);
                        tokens.title = summary.estimated ? '总 token 用量（含按字符数估算的部分）' : '总 token 用量';
                        summaryLine.appendChild(tokens);
                    }
                    if (summary.models.length) summaryLine.appendChild(h('span', 'mono models', `· ${summary.models.join(', ')}`));
                }
                const willExpandAll = EXPANSION_KINDS.some(name => !commands[name].expanded);
                const label = willExpandAll ? '全部展开' : '全部收起';
                toggleAllBtn.title = label;
                toggleAllBtn.setAttribute('aria-label', label);
                toggleAllBtn.firstChild.textContent = willExpandAll ? 'maximize_2' : 'minimize_2';
                refreshBtn.classList.toggle('loading', loading);
            }

            function renderState() {
                const records = data.records;
                state.hidden = true;
                state.className = 'side-traj-state';
                if (loadError) {
                    state.hidden = false;
                    state.classList.add('error');
                    state.textContent = '';
                    state.append(h('p', '', '读取调用轨迹失败'), h('p', 'side-traj-state-detail', loadError));
                } else if (!sessionKey) {
                    state.hidden = false;
                    state.textContent = '请先在主聊天里选择一个智能体和话题。';
                } else if (loading && records.length === 0) {
                    state.hidden = false;
                    state.textContent = '正在加载调用轨迹…';
                } else if (records.length === 0) {
                    state.hidden = false;
                    state.textContent = '这个话题还没有模型调用记录。发一条消息后，每次发给模型的请求和它的回答都会记在这里。';
                }
                truncatedNotice.hidden = !data.truncated;
            }

            function renderTimeline() {
                const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_THRESHOLD_PX;
                const previousTop = scroller.scrollTop;
                const nextCache = new Map();
                const fragment = doc.createDocumentFragment();
                buildObserver?.disconnect();
                items.forEach((item, index) => {
                    const sig = signature(item, index);
                    let entry = cardCache.get(item.key);
                    if (!entry || entry.sig !== sig) {
                        entry = buildCard(item, index);
                        entry.sig = sig;
                    }
                    nextCache.set(item.key, entry);
                    fragment.appendChild(entry.el);
                });
                cardCache = nextCache;
                rowRegistry = new Map();
                for (const entry of cardCache.values()) for (const row of entry.rows) rowRegistry.set(row.key, row);
                timeline.replaceChildren(fragment);
                const entries = [...cardCache.values()];
                entries.forEach((entry, index) => {
                    if (entry.built) return;
                    if (!buildObserver || index >= entries.length - EAGER_TAIL_CARDS) entry.ensure();
                    else buildObserver.observe(entry.el);
                });
                updateAllRows();
                if (!doc.hidden) {
                    stickToBottom = wasAtBottom || previousTop === 0;
                    if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
                    else scroller.scrollTop = previousTop;
                }
            }

            function renderAll() {
                renderHeader();
                renderState();
                renderTimeline();
                recomputeSearch(false);
                if (focusRequestId && !loading && !focusCall(focusRequestId)) {
                    focusRequestId = null;
                    if (sessionKey && !loadError) toast('这条回复没有对应的调用记录（可能发送于启用调用轨迹之前，或已被清空）', 'info');
                }
            }

            // ---------------------------------------------------------------- 搜索
            function clearHighlights() {
                win.CSS?.highlights?.delete?.(HIGHLIGHT);
                win.CSS?.highlights?.delete?.(HIGHLIGHT_ACTIVE);
            }

            function collectRanges(element, normalizedQuery) {
                const ranges = [];
                const walker = doc.createTreeWalker(element, 4 /* SHOW_TEXT */);
                let node = walker.nextNode();
                while (node) {
                    for (const match of findTextMatches(node.data, normalizedQuery)) {
                        const range = doc.createRange();
                        range.setStart(node, match.sourceStart);
                        range.setEnd(node, match.sourceEnd);
                        ranges.push(range);
                    }
                    node = walker.nextNode();
                }
                return ranges;
            }

            function matchRange(match, preferExpanded) {
                const rowEl = rowRegistry.get(match.expansionKey)?.el;
                if (!rowEl) return null;
                let fields = [...rowEl.querySelectorAll(`[data-trajectory-search-field="${match.field}"]`)];
                if (preferExpanded && rowEl.classList.contains('open')) {
                    const expandedFields = fields.filter(el => el.closest('.side-traj-expanded'));
                    if (expandedFields.length) fields = expandedFields;
                }
                const ranges = fields.flatMap(el => collectRanges(el, searchIndex.query));
                return ranges[match.fieldMatchIndex] || ranges[0] || null;
            }

            function applyHighlights() {
                highlightFrame = 0;
                if (!searchIndex.query) { clearHighlights(); return; }
                const active = searchIndex.matches[clampActive()] || null;
                const activeRange = active ? matchRange(active, true) : null;
                if (hasHighlights) {
                    const ranges = searchIndex.matches.map(match => matchRange(match, false)).filter(Boolean);
                    win.CSS.highlights.set(HIGHLIGHT, new win.Highlight(...ranges));
                    win.CSS.highlights.set(HIGHLIGHT_ACTIVE, new win.Highlight(...(activeRange ? [activeRange] : [])));
                }
                if (activeRange && typeof activeRange.getBoundingClientRect === 'function') {
                    const rect = activeRange.getBoundingClientRect();
                    const box = scroller.getBoundingClientRect();
                    if (rect.top < box.top || rect.bottom > box.bottom) {
                        scroller.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2);
                    }
                }
            }
            function scheduleHighlights() {
                if (highlightFrame && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(highlightFrame);
                if (typeof win.requestAnimationFrame !== 'function') { applyHighlights(); return; }
                // 两帧：先让被展开的行排好版，再按文本位置定位
                highlightFrame = win.requestAnimationFrame(() => { highlightFrame = win.requestAnimationFrame(applyHighlights); });
            }

            function renderSearchBar() {
                const count = searchIndex.matches.length;
                searchCount.textContent = count > 0 ? `${clampActive() + 1}/${count}` : '0/0';
                searchPrev.disabled = searchNext.disabled = count === 0;
            }

            const ensureActiveMatchBuilt = () => {
                const active = searchIndex.matches[clampActive()];
                if (active) ensureCard(active.callKey);
            };

            function recomputeSearch(resetActive = true) {
                searchIndex = searchOpen ? buildSearchIndex(items, searchQuery) : { query: '', matches: [] };
                if (resetActive) searchActive = 0;
                ensureActiveMatchBuilt();
                renderSearchBar();
                updateAllRows();
                scheduleHighlights();
            }

            function openSearch() {
                searchOpen = true;
                searchBar.hidden = false;
                searchInput.focus();
                searchInput.select();
            }
            function closeSearch() {
                if (!searchOpen && !searchQuery) return;
                searchOpen = false;
                searchQuery = '';
                searchActive = 0;
                searchInput.value = '';
                searchBar.hidden = true;
                searchIndex = { query: '', matches: [] };
                clearHighlights();
                renderSearchBar();
                updateAllRows();
            }
            function moveSearch(direction) {
                const count = searchIndex.matches.length;
                if (count === 0) return;
                searchActive = (clampActive() + direction + count) % count;
                ensureActiveMatchBuilt();
                renderSearchBar();
                updateAllRows();
                const card = timeline.querySelector(`[data-trajectory-call="${CSS_escape(searchIndex.matches[clampActive()].callKey)}"]`);
                card?.scrollIntoView?.({ block: 'nearest' });
                scheduleHighlights();
            }
            searchInput.addEventListener('input', () => {
                searchQuery = searchInput.value;
                if (searchTimer) win.clearTimeout(searchTimer);
                searchTimer = win.setTimeout(() => { searchTimer = null; recomputeSearch(true); }, SEARCH_DEBOUNCE_MS);
            });
            searchInput.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
                else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (searchTimer) { win.clearTimeout(searchTimer); searchTimer = null; recomputeSearch(true); }
                    moveSearch(event.shiftKey ? -1 : 1);
                }
            });
            const onFindShortcut = event => {
                if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f' && scope.contains(doc.activeElement)) {
                    event.preventDefault();
                    openSearch();
                }
            };
            scope.addEventListener('keydown', onFindShortcut);

            // ---------------------------------------------------------------- 展开 / 收起
            function toggleAll() {
                const expanded = EXPANSION_KINDS.some(name => !commands[name].expanded);
                version += 1;
                overrides = new Map();
                commands = Object.fromEntries(EXPANSION_KINDS.map(name => [name, { expanded, version }]));
                renderHeader();
                renderMenu();
                updateAllRows();
            }
            function toggleKind(name) {
                version += 1;
                commands = { ...commands, [name]: { expanded: !commands[name].expanded, version } };
                renderHeader();
                renderMenu();
                updateAllRows();
            }
            function renderMenu() {
                menu.innerHTML = '';
                for (const name of EXPANSION_KINDS) {
                    const item = h('button', 'side-traj-menu-item');
                    item.type = 'button';
                    item.setAttribute('role', 'menuitemcheckbox');
                    item.setAttribute('aria-checked', String(commands[name].expanded));
                    item.dataset.trajectoryExpansionKind = name;
                    item.append(h('span', '', EXPANSION_LABELS[name]), h('span', `side-traj-switch${commands[name].expanded ? ' on' : ''}`));
                    item.addEventListener('click', event => { event.stopPropagation(); toggleKind(name); });
                    menu.appendChild(item);
                }
            }
            function toggleMenu() {
                menu.hidden = !menu.hidden;
                if (!menu.hidden) renderMenu();
            }
            const onDocumentClick = event => {
                if (!menu.hidden && !menu.contains(event.target) && !menuBtn.contains(event.target)) menu.hidden = true;
            };
            doc.addEventListener('click', onDocumentClick);

            // ---------------------------------------------------------------- 定位到某次调用（来自消息的「查看调用轨迹」）
            function focusCall(requestId) {
                const entry = items.findLast(item => item.record.requestId === requestId);
                if (!entry) return false;
                focusRequestId = null;
                const card = ensureCard(entry.key)?.el;
                if (!card) return false;
                stickToBottom = false;
                card.scrollIntoView?.({ block: 'start' });
                card.classList.add('flash');
                win.setTimeout(() => card.classList.remove('flash'), 1600);
                return true;
            }

            // ---------------------------------------------------------------- 数据
            const currentKey = () => {
                const conversation = getConversation?.() || null;
                conversationLabel = conversation?.item?.name || '';
                return trajectoryKeyFor(conversation);
            };

            async function load() {
                const key = currentKey();
                const seq = ++loadSeq;
                if (key !== sessionKey) {
                    sessionKey = key;
                    data = { records: [], truncated: false, total: 0 };
                    items = [];
                    overrides = new Map();
                    cardCache = new Map();
                    closeSearch();
                }
                if (!sessionKey) { loading = false; loadError = ''; renderAll(); return; }
                loading = true;
                renderHeader();
                renderState();
                let res;
                try {
                    res = await api?.modelTrajectoryList?.(sessionKey, { limit: 200 });
                } catch (error) {
                    // 主进程没有这组接口（只刷新了页面、主进程还是旧的）时 invoke 会直接抛错，
                    // 不能让它冒出 mountTab，否则整页被移除、只剩空白
                    const missing = /No handler registered/i.test(String(error?.message || error));
                    res = { success: false, error: missing ? '调用轨迹服务未启动，请完全退出并重新打开 VCPChat' : (error?.message || '读取调用轨迹失败') };
                }
                if (disposed || seq !== loadSeq) return;
                loading = false;
                if (res?.success) {
                    data = res.data;
                    loadError = '';
                } else {
                    loadError = res?.error || '读取调用轨迹失败';
                }
                items = buildTimeline(data.records);
                renderAll();
            }

            function scheduleReload() {
                if (reloadTimer) return;
                reloadTimer = win.setTimeout(() => { reloadTimer = null; void load(); }, RELOAD_DEBOUNCE_MS);
            }

            async function openDirectory() {
                const res = await api?.modelTrajectoryOpenDirectory?.();
                if (!res?.success) toast(res?.error || '无法打开记录目录', 'error');
            }

            async function clearAll() {
                if (!sessionKey) return;
                const confirmed = typeof win.confirm === 'function' ? win.confirm('清空这个话题的全部调用轨迹？此操作不可撤销。') : true;
                if (!confirmed) return;
                const res = await api?.modelTrajectoryClear?.(sessionKey);
                if (res?.success) toast('已清空调用轨迹', 'success');
                else toast(res?.error || '清空失败', 'error');
            }

            const onChanged = change => {
                if (disposed || !change) return;
                if (change.sessionKey === sessionKey || change.sessionKey === currentKey()) scheduleReload();
            };

            const instance = { focusCall: requestId => { focusRequestId = requestId; if (!loading) renderAll(); } };
            instances.add(instance);
            requestedRequestId = null;

            renderHeader();
            renderState();
            try {
                const watched = await api?.modelTrajectoryWatch?.();
                if (watched?.success) unwatch = () => api?.modelTrajectoryUnwatch?.();
                unsubscribe = api?.onModelTrajectoryChanged?.(onChanged) || null;
            } catch (_error) { /* 订阅失败时仍可手动刷新 */ }
            // 切换智能体 / 话题时由主聊天通知；轮询只是兜底（比如话题被外部流程切换）
            unsubscribeConversation = onConversationChange?.(() => { if (!disposed && currentKey() !== sessionKey) void load(); }) || null;
            const followTick = () => { if (!disposed && currentKey() !== sessionKey) return load(); return undefined; };
            // 由控制器下发可见性时只在标签可见时轮询；直接调用（没有 scope）时退回到看窗口是否可见
            if (viewScope && occurrence) pollWhileVisible(viewScope, occurrence.visible, followTick, FOLLOW_POLL_MS, { label: 'trajectory-follow' });
            else poller = win.setInterval(() => { if (!doc.hidden) void followTick(); }, FOLLOW_POLL_MS);
            await load();

            return {
                focus() { searchOpen ? searchInput.focus() : scroller.focus?.({ preventScroll: true }); },
                dispose() {
                    disposed = true;
                    instances.delete(instance);
                    if (poller) win.clearInterval(poller);
                    if (reloadTimer) win.clearTimeout(reloadTimer);
                    if (searchTimer) win.clearTimeout(searchTimer);
                    if (highlightFrame && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(highlightFrame);
                    buildObserver?.disconnect();
                    clearHighlights();
                    doc.removeEventListener('click', onDocumentClick);
                    try { unsubscribe?.(); } catch (_error) { /* 已取消 */ }
                    try { void Promise.resolve(unwatch?.()).catch(() => {}); } catch (_error) { /* 主进程不支持 */ }
                    unwatch = null;
                    try { unsubscribeConversation?.(); } catch (_error) { /* 已取消 */ }
                    viewElement.innerHTML = '';
                    viewElement.classList.remove('side-traj-view');
                }
            };
        }
    };
}

function CSS_escape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}
