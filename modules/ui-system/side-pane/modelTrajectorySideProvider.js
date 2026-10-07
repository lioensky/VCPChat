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

import { createSidePaneRootScope, pollWhileVisible } from './side-pane-occurrence.js';
import { moveMenuFocus } from './menu-position.js';
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
    /** @type {Set<{show: (requestId: string | null) => void}>} */
    const instances = new Set();
    let requestedRequestId = null;
    // 从辅助对话打开时看的是它的子话题（同 ZCode 打开时显式带上会话）；主聊天切换会话或从主聊天再打开时回到跟随主聊天
    let pinnedConversation = null;

    return {
        kind,

        /**
         * 打开（或聚焦）调用轨迹标签；带 requestId（消息 id）时滚动到对应的那次调用。
         * conversation（{ item: { id, name }, topicId }）指定要看的会话，不传就跟随主聊天当前会话。
         */
        async openModelTrajectoryTab({ requestId = null, conversation = null } = {}) {
            if (!sidePaneController) return null;
            requestedRequestId = requestId;
            pinnedConversation = trajectoryKeyFor(conversation) ? conversation : null;
            const handle = await sidePaneController.openTab({
                id: TAB_ID,
                kind,
                title: '调用轨迹',
                icon: 'monitoring',
                closable: true,
                scopeMode: 'global'
            });
            sidePaneController.setVisible?.(true);
            for (const instance of instances) instance.show(requestId);
            handle?.focus?.();
            return handle;
        },

        async mountTab(tab, viewElement, { scope: viewScope = null, restoredState = null, occurrence = null } = {}) {
            if (!viewElement) return null;
            viewElement.innerHTML = '';
            viewElement.classList.add('side-traj-view');
            // 这次挂载里长期存在的监听、定时器、推送订阅都归 own，控制器释放 view 或调用 dispose 时一起拆掉。
            // 卡片和菜单项每次渲染都重建，它们自己的监听跟着元素一起丢弃，不挂到 own 上，免得记录越积越多
            const own = createSidePaneRootScope(viewScope, 'model-trajectory');
            const disposed = () => !own.active;

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
            // 常驻按钮的监听归 own；卡片里的按钮每次重建卡片都会换新，监听跟着元素一起丢弃（inline），
            // 不然每次刷新都往 own 上多记一条，连同闭包里整段消息文本一直留到视图释放
            const iconButton = (name, label, onClick, className = '', { inline = false } = {}) => {
                const btn = h('button', `side-traj-icon-btn ${className}`.trim());
                btn.type = 'button';
                btn.title = label;
                btn.setAttribute('aria-label', label);
                btn.appendChild(icon(name));
                if (onClick && inline) btn.addEventListener('click', onClick);
                else if (onClick) own.listen(btn, 'click', onClick);
                return btn;
            };

            // ---------------------------------------------------------------- 状态
            let sessionKey = null;
            let conversationLabel = '';
            let data = { records: [], truncated: false, total: 0 };
            let items = [];
            // 挂载时还没确定话题，先算加载中：否则订阅推送的那一下会闪出「请先选择智能体和话题」
            let loading = true;
            let loadError = '';
            let loadErrorCode = '';
            let loadSeq = 0;
            let cancelReload = null;
            let cancelSearch = null;
            let followsConversation = false;
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
            // data-action：与文案无关的稳定钩子
            Object.entries({ search: searchBtn, 'expansion-menu': menuBtn, 'toggle-all': toggleAllBtn, 'open-directory': folderBtn, clear: clearBtn, refresh: refreshBtn, 'search-prev': searchPrev, 'search-next': searchNext, 'search-close': searchClose })
                .forEach(([action, btn]) => { btn.dataset.action = action; });
            header.append(titleRow, summaryLine, searchBar);

            const menu = h('div', 'side-traj-menu');
            menu.hidden = true;
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', '自定义展开');
            menuBtn.setAttribute('aria-haspopup', 'menu');
            menuBtn.setAttribute('aria-expanded', 'false');

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
            if (buildObserver) own.own(() => buildObserver.disconnect(), 'card-build-observer', 'observer');
            own.listen(scroller, 'scroll', () => {
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

            // 行高测量所有行共用一帧：先把每行的高度都读完，再统一改 class。
            // 逐行“读一次写一次”的话每行都强制一次布局，一百多行的轨迹打开要卡好几秒
            const pendingMeasures = new Set();
            let measureFrame = 0;
            const flushMeasures = () => {
                measureFrame = 0;
                const jobs = [...pendingMeasures];
                pendingMeasures.clear();
                const results = jobs.map(job => job.read());
                jobs.forEach((job, index) => job.write(results[index]));
            };
            const scheduleMeasure = (job) => {
                if (typeof win.requestAnimationFrame !== 'function') return;
                pendingMeasures.add(job);
                if (!measureFrame) measureFrame = win.requestAnimationFrame(flushMeasures);
            };
            own.own(() => {
                if (measureFrame && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(measureFrame);
                measureFrame = 0;
                pendingMeasures.clear();
            }, 'row-measure-frame');

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
                }, 'side-traj-row-copy', { inline: true });
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

                // read 只读布局，write 只改 DOM：同一帧里先跑完所有行的 read 再跑 write
                const measureJob = {
                    read: () => (row.classList.contains('open') && !showAll
                        ? content.scrollHeight > content.clientHeight + 2
                        : null),
                    write: (overflowing) => {
                        if (overflowing === null) return;
                        shell.classList.toggle('overflowing', overflowing);
                        more.hidden = !overflowing || row.classList.contains('revealed');
                        more.textContent = '展开';
                    },
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
                    else scheduleMeasure(measureJob);
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
                if (!has) { closeMenu(); closeSearch(); }
                summaryLine.hidden = !has;
                summaryLine.textContent = '';
                summaryLine.dataset.callCount = String(records.length);
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
                // data-state：error / service-missing / no-conversation / loading / empty
                let stateKey = '';
                if (loadError) {
                    stateKey = loadErrorCode || 'error';
                    state.hidden = false;
                    state.classList.add('error');
                    state.textContent = '';
                    state.append(h('p', '', '读取调用轨迹失败'), h('p', 'side-traj-state-detail', loadError));
                } else if (loading && records.length === 0) {
                    stateKey = 'loading';
                    state.hidden = false;
                    state.textContent = '正在加载调用轨迹…';
                } else if (!sessionKey) {
                    stateKey = 'no-conversation';
                    state.hidden = false;
                    state.textContent = '请先在主聊天里选择一个智能体和话题。';
                } else if (records.length === 0) {
                    stateKey = 'empty';
                    state.hidden = false;
                    state.textContent = '这个话题还没有模型调用记录。发一条消息后，每次发给模型的请求和它的回答都会记在这里。';
                }
                if (stateKey) state.dataset.state = stateKey;
                else delete state.dataset.state;
                truncatedNotice.hidden = !data.truncated;
            }

            function renderTimeline() {
                const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_THRESHOLD_PX;
                const previousTop = scroller.scrollTop;
                // 第一次画出内容时贴到底；之后只看读者原来在不在底部，停在顶部读第一条调用的人不会被拉走
                const firstContent = timeline.childElementCount === 0;
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
                    stickToBottom = wasAtBottom || firstContent;
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
            own.listen(searchInput, 'input', () => {
                searchQuery = searchInput.value;
                cancelSearch?.();
                cancelSearch = own.timeout(() => { cancelSearch = null; recomputeSearch(true); }, SEARCH_DEBOUNCE_MS, 'search-debounce');
            });
            own.listen(searchInput, 'keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
                else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (cancelSearch) { cancelSearch(); cancelSearch = null; recomputeSearch(true); }
                    moveSearch(event.shiftKey ? -1 : 1);
                }
            });
            const onFindShortcut = event => {
                if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f' && scope.contains(doc.activeElement)) {
                    event.preventDefault();
                    openSearch();
                }
            };
            own.listen(scope, 'keydown', onFindShortcut);

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
                // 切换开关会重建菜单项：键盘用户的焦点留在同一项上，不掉到 body
                const focusedKind = menu.contains(doc.activeElement) ? doc.activeElement.dataset?.trajectoryExpansionKind : null;
                menu.innerHTML = '';
                for (const name of EXPANSION_KINDS) {
                    const item = h('button', 'side-traj-menu-item');
                    item.type = 'button';
                    item.setAttribute('role', 'menuitemcheckbox');
                    item.setAttribute('aria-checked', String(commands[name].expanded));
                    item.dataset.trajectoryExpansionKind = name;
                    item.append(h('span', '', EXPANSION_LABELS[name]), h('span', `side-traj-switch${commands[name].expanded ? ' on' : ''}`));
                    item.tabIndex = -1;
                    item.addEventListener('click', event => { event.stopPropagation(); toggleKind(name); });
                    menu.appendChild(item);
                }
                if (focusedKind) menu.querySelector(`[data-trajectory-expansion-kind="${focusedKind}"]`)?.focus();
            }
            function closeMenu({ restoreFocus = false } = {}) {
                if (menu.hidden) return;
                const hadFocus = menu.contains(doc.activeElement);
                menu.hidden = true;
                menuBtn.setAttribute('aria-expanded', 'false');
                if (restoreFocus || hadFocus) menuBtn.focus();
            }
            function toggleMenu() {
                if (!menu.hidden) { closeMenu(); return; }
                menu.hidden = false;
                menuBtn.setAttribute('aria-expanded', 'true');
                renderMenu();
                // 和 Radix DropdownMenu 一样：打开即把焦点放进菜单，方向键在开关间移动，Esc 或 Tab 收起回到按钮
                menu.querySelector('[role="menuitemcheckbox"]')?.focus();
            }
            const onDocumentClick = event => {
                if (!menu.hidden && !menu.contains(event.target) && !menuBtn.contains(event.target)) closeMenu();
            };
            own.listen(doc, 'click', onDocumentClick);
            own.listen(menu, 'keydown', event => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeMenu({ restoreFocus: true });
                    return;
                }
                moveMenuFocus(event, [...menu.querySelectorAll('[role="menuitemcheckbox"]')]);
            });

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
                if (!disposed()) own.timeout(() => card.classList.remove('flash'), 1600, 'focus-flash');
                return true;
            }

            // ---------------------------------------------------------------- 数据
            const currentKey = () => {
                const conversation = pinnedConversation || getConversation?.() || null;
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
                    res = { success: false, error: missing ? '调用轨迹服务未启动，请完全退出并重新打开 VCPChat' : (error?.message || '读取调用轨迹失败'), code: missing ? 'service-missing' : '' };
                }
                if (disposed() || seq !== loadSeq) return;
                loading = false;
                if (res?.success) {
                    data = res.data;
                    loadError = '';
                    loadErrorCode = '';
                } else {
                    loadError = res?.error || '读取调用轨迹失败';
                    loadErrorCode = res?.code || '';
                }
                items = buildTimeline(data.records);
                renderAll();
            }

            function scheduleReload() {
                if (cancelReload || disposed()) return;
                cancelReload = own.timeout(() => { cancelReload = null; void load(); }, RELOAD_DEBOUNCE_MS, 'reload-debounce');
            }

            async function openDirectory() {
                const res = await api?.modelTrajectoryOpenDirectory?.();
                if (!res?.success) toast(res?.error || '无法打开记录目录', 'error');
            }

            async function clearAll() {
                if (!sessionKey) return;
                // 记下点按钮时的话题：确认框开着时切了会话，也只清这一个
                const key = sessionKey;
                const message = '清空这个话题的全部调用轨迹？此操作不可撤销。';
                // 用应用自己的确认框；原生 window.confirm 会弹系统模态框卡住整个窗口，只在没有应用确认框时退回
                const confirmed = typeof uiHelper?.showConfirmDialog === 'function'
                    ? await uiHelper.showConfirmDialog(message, '清空调用轨迹', '清空', '取消', true)
                    : (typeof win.confirm === 'function' ? win.confirm(message) : true);
                if (!confirmed || disposed()) return;
                const res = await api?.modelTrajectoryClear?.(key);
                if (res?.success) toast('已清空调用轨迹', 'success');
                else toast(res?.error || '清空失败', 'error');
            }

            // 标签藏着时收到的轨迹更新和话题切换只记一笔，重新显示时读一次，不在后台反复重读
            let staleWhileHidden = false;
            const isHidden = () => occurrence?.isVisible?.() === false;
            const reloadWhenShown = (reload) => {
                if (isHidden()) staleWhileHidden = true;
                else reload();
            };

            const onChanged = change => {
                if (disposed() || !change) return;
                if (change.sessionKey === sessionKey || change.sessionKey === currentKey()) reloadWhenShown(scheduleReload);
            };

            const instance = {
                show: requestId => {
                    if (requestId) focusRequestId = requestId;
                    // 换了要看的会话（比如从辅助对话打开）先读那个会话，读完再定位
                    if (currentKey() !== sessionKey) void load();
                    else if (!loading) renderAll();
                }
            };
            instances.add(instance);
            own.own(() => instances.delete(instance), 'focus-request-target');
            own.own(() => {
                if (highlightFrame && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(highlightFrame);
                clearHighlights();
            }, 'search-highlights');
            requestedRequestId = null;

            renderHeader();
            renderState();
            try {
                const watched = await api?.modelTrajectoryWatch?.();
                const unwatch = () => { void Promise.resolve(api?.modelTrajectoryUnwatch?.()).catch(() => {}); };
                // 等主进程回话期间标签可能已经关了：这时直接退掉刚登记的推送，不再接监听
                if (watched?.success) {
                    if (disposed()) unwatch();
                    else own.own(unwatch, 'trajectory-watch', 'subscription');
                }
                if (!disposed()) own.subscribe(() => api?.onModelTrajectoryChanged?.(onChanged), 'trajectory-changed');
            } catch (_error) { /* 订阅失败时仍可手动刷新 */ }
            // 挂载途中被取消（关标签、重新挂载）：控制器会丢掉这个视图，这里只清掉自己画的内容
            if (disposed()) { viewElement.innerHTML = ''; viewElement.classList.remove('side-traj-view'); return null; }
            // 切换智能体 / 话题（包括删掉当前助手）都由主聊天通知，接上了就不用轮询
            own.subscribe(() => {
                const off = onConversationChange?.(() => {
                    pinnedConversation = null;
                    if (!disposed() && currentKey() !== sessionKey) reloadWhenShown(() => void load());
                });
                followsConversation = typeof off === 'function';
                return followsConversation ? off : null;
            }, 'conversation-follow');
            if (!followsConversation) {
                // 没有切换通知（单独挂载、没有主聊天）时才轮询兜底：有控制器下发可见性就只在标签可见时轮询，否则看窗口是否可见
                const followTick = () => { if (!disposed() && currentKey() !== sessionKey) return load(); return undefined; };
                if (occurrence?.visible) pollWhileVisible(own, occurrence.visible, followTick, FOLLOW_POLL_MS, { label: 'trajectory-follow' });
                else own.interval(() => { if (!doc.hidden) void followTick(); }, FOLLOW_POLL_MS, 'trajectory-follow');
            }
            await load();
            // 休眠前的阅读位置：还是同一个会话才接回展开 / 收起和滚动位置，否则藏了 5 分钟回来就被收回默认并拉到底
            if (restoredState && !disposed() && restoredState.sessionKey === sessionKey && sessionKey) {
                if (Array.isArray(restoredState.overrides)) overrides = new Map(restoredState.overrides);
                if (restoredState.commands) commands = restoredState.commands;
                if (Number.isFinite(restoredState.version)) version = restoredState.version;
                renderHeader();
                renderMenu();
                updateAllRows();
                if (restoredState.stickToBottom === false && Number.isFinite(restoredState.scrollTop)) {
                    stickToBottom = false;
                    scroller.scrollTop = restoredState.scrollTop;
                }
            }

            return {
                focus() { searchOpen ? searchInput.focus() : scroller.focus?.({ preventScroll: true }); },
                captureState() {
                    return { sessionKey, overrides: [...overrides], commands, version, stickToBottom, scrollTop: scroller.scrollTop };
                },
                suspend() {
                    // 还没到点的重读留到重新显示时再做
                    if (!cancelReload) return;
                    cancelReload();
                    cancelReload = null;
                    staleWhileHidden = true;
                },
                resume() {
                    if (disposed() || (!staleWhileHidden && currentKey() === sessionKey)) return;
                    staleWhileHidden = false;
                    void load();
                },
                dispose() {
                    // DOM 同步清掉：scope 的释放是异步的，不能等它，免得把紧接着重新挂载的内容一起清掉
                    viewElement.innerHTML = '';
                    viewElement.classList.remove('side-traj-view');
                    return own.dispose('model-trajectory-disposed');
                }
            };
        }
    };
}

function CSS_escape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}
