/**
 * modules/ui-system/side-pane/toolOutputSideProvider.js
 * VCPChat Universal Sub-screen - 命令输出 Provider
 *
 * 后台命令输出标签：在侧栏里看一条命令跑到哪了、输出什么。
 * 数据来自 VCPChat 自己的终端（PowerShellExecutor 记录的 AI 短命令运行），
 * 与状态面板「终端」章节、侧栏终端标签共用同一个会话，不另起进程。
 */

'use strict';

import { formatRelativeTime } from './side-pane-tab-utils.js';
import { getCommandRunsSource } from '../sources/terminal-command-runs.js';

const TAB_ID = 'tool-output:main';
const FOLLOW_THRESHOLD_PX = 24;
const TICK_MS = 1000;

const STATUS_LABEL = Object.freeze({
    running: '运行中',
    completed: '已完成',
    cancelled: '已取消',
    timed_out: '已超时',
    spawn_error: '启动失败'
});

export const toolOutputTabId = () => TAB_ID;

export function commandRunStatusLabel(status) {
    return STATUS_LABEL[status] || status || '';
}

/** 「1.2 秒」「3 分 05 秒」。 */
export function formatRunDuration(run, now = Date.now()) {
    if (!Number.isFinite(run?.startedAt)) return '';
    const ms = Math.max(0, (run.endedAt || now) - run.startedAt);
    if (ms < 1000) return `${ms} 毫秒`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;
    const minutes = Math.floor(ms / 60000);
    return `${minutes} 分 ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} 秒`;
}

const oneLine = (command, max = 60) => {
    const text = String(command || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function createToolOutputSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    uiHelper = null,
    // 和状态面板共用的命令运行记录源
    commandRunsSource = getCommandRunsSource(api)
} = {}) {
    const kind = 'tool-output';
    const win = doc.defaultView || window;
    const toast = (message, type = 'info') => uiHelper?.showToastNotification?.(message, type);
    /** @type {Set<{select: (id: string) => void}>} */
    const instances = new Set();
    let requestedRunId = null;

    return {
        kind,

        /** 打开（或聚焦）命令输出标签；带 runId 时直接定位到那条命令。 */
        async openToolOutputTab({ runId = null } = {}) {
            if (!sidePaneController) return null;
            requestedRunId = runId;
            const handle = await sidePaneController.openTab({
                id: TAB_ID,
                kind,
                title: '命令输出',
                icon: 'description',
                closable: true,
                scopeMode: 'global',
                searchHint: '后台输出 命令 终端'
            });
            sidePaneController.setVisible?.(true);
            if (runId) for (const instance of instances) instance.select(runId);
            handle?.focus?.();
            return handle;
        },

        async mountTab(tab, viewElement, { scope: viewScope = null, occurrence = null } = {}) {
            if (!viewElement) return null;
            viewElement.innerHTML = '';
            viewElement.classList.add('side-tool-output-view');

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
            const iconButton = (name, label, onClick) => {
                const btn = h('button', 'side-tool-output-icon-btn');
                btn.type = 'button';
                btn.title = label;
                btn.setAttribute('aria-label', label);
                btn.appendChild(icon(name));
                btn.addEventListener('click', onClick);
                return btn;
            };

            const scope = h('div', 'zc-scope vcp-ui-scope side-tool-output-scope');
            const toolbar = h('div', 'side-tool-output-toolbar');
            const picker = h('select', 'side-tool-output-picker');
            picker.setAttribute('aria-label', '选择命令');
            const copyBtn = iconButton('content_copy', '复制输出', () => copyOutput());
            const refreshBtn = iconButton('refresh', '刷新', () => { void loadSelected(); });
            const actions = h('div', 'side-tool-output-actions');
            actions.append(copyBtn, refreshBtn);
            toolbar.append(picker, actions);

            const statusBar = h('div', 'side-tool-output-status');
            const commandLine = h('div', 'side-tool-output-command');
            const outputWrap = h('div', 'side-tool-output-scroll');
            const output = h('pre', 'side-tool-output-text');
            output.tabIndex = 0;
            outputWrap.appendChild(output);
            // 悬浮的圆形「回到底部」箭头。
            const followBtn = h('button', 'side-tool-output-follow');
            followBtn.type = 'button';
            followBtn.hidden = true;
            followBtn.title = '回到底部';
            followBtn.setAttribute('aria-label', '回到底部');
            followBtn.appendChild(icon('arrow_downward'));
            followBtn.addEventListener('click', resumeFollow);
            const errorBar = h('div', 'side-tool-output-error');
            errorBar.setAttribute('role', 'alert');
            errorBar.hidden = true;
            const errorText = h('span', 'side-tool-output-error-text');
            const retryBtn = h('button', 'side-tool-output-error-retry', '重试');
            retryBtn.type = 'button';
            retryBtn.addEventListener('click', () => { void loadSelected(); });
            errorBar.append(errorText, retryBtn);
            const notice = h('div', 'side-tool-output-notice');
            notice.hidden = true;
            const empty = h('div', 'side-tool-output-empty');
            empty.hidden = true;

            scope.append(toolbar, errorBar, statusBar, commandLine, notice, outputWrap, followBtn, empty);
            viewElement.appendChild(scope);

            let runs = [];
            let selectedId = requestedRunId;
            let manual = Boolean(requestedRunId);
            let detail = null;
            let loadError = '';
            let follow = true;
            let previousTop = 0;
            let disposed = false;
            let loadSeq = 0;
            let releaseRuns = null;
            let seeded = false;
            let seeding = null;
            // 控制器挂载前就给出了可见性：在后台挂载（比如恢复布局）时一开始就是暂停的
            let suspended = occurrence?.isVisible?.() === false;
            // 暂停期间只记下最新一份列表，重新显示时再渲染、再读输出
            let hiddenUpdate = null;
            let ticker = null;
            let reloadTimer = null;

            const selectedSummary = () => runs.find(run => run.id === selectedId) || null;

            const scrollToEnd = () => {
                outputWrap.scrollTop = outputWrap.scrollHeight;
                previousTop = outputWrap.scrollTop;
                followBtn.hidden = true;
            };
            function resumeFollow() {
                follow = true;
                renderOutput();
                scrollToEnd();
            }
            // 只有「用户向上滚」才暂停跟随，暂停期间输出冻结（不再被新内容顶得乱跳、选中的文字也不会丢）；
            // 手动滚回底部或点箭头才恢复，并一次性补上最新内容。
            outputWrap.addEventListener('scroll', () => {
                const top = outputWrap.scrollTop;
                const atEnd = outputWrap.scrollHeight - top - outputWrap.clientHeight <= FOLLOW_THRESHOLD_PX;
                if (follow && top < previousTop && !atEnd) {
                    follow = false;
                } else if (!follow && atEnd) {
                    follow = true;
                    renderOutput();
                    scrollToEnd();
                }
                previousTop = outputWrap.scrollTop;
                followBtn.hidden = follow || !detail;
            });

            const renderPicker = () => {
                picker.innerHTML = '';
                for (const run of runs) {
                    const option = h('option', '', `${run.status === 'running' ? '● ' : ''}${oneLine(run.command, 48)}`);
                    option.value = run.id;
                    option.title = run.command;
                    picker.appendChild(option);
                }
                if (selectedId) picker.value = selectedId;
                picker.disabled = runs.length === 0;
            };

            const renderStatus = () => {
                const summary = detail || selectedSummary();
                statusBar.innerHTML = '';
                commandLine.textContent = '';
                if (!summary) return;
                const running = summary.status === 'running';
                const chip = h('span', `side-tool-output-chip status-${summary.status}`);
                chip.append(icon(running ? 'progress_activity' : summary.status === 'completed' ? 'check_circle' : 'cancel', running ? 'spin' : ''), h('span', '', commandRunStatusLabel(summary.status)));
                const meta = h('span', 'side-tool-output-meta', `${formatRunDuration(summary)} · ${formatRelativeTime(summary.startedAt)}`);
                statusBar.append(chip, meta);
                commandLine.textContent = summary.command;
                commandLine.title = summary.command;
            };

            const renderOutput = () => {
                const hasRuns = runs.length > 0;
                empty.hidden = hasRuns;
                empty.textContent = hasRuns ? '' : '还没有命令记录。让管家用 PowerShellExecutor 跑一条命令，输出会显示在这里。';
                outputWrap.hidden = !hasRuns;
                notice.hidden = !detail?.truncated;
                if (detail?.truncated) notice.textContent = '输出过长，只显示最后一部分。完整内容请在终端里查看。';
                copyBtn.disabled = !detail?.output;
                errorBar.hidden = !loadError;
                errorText.textContent = loadError;
                if (!detail) { output.textContent = hasRuns ? (loadError ? '' : '加载中…') : ''; return; }
                if (!follow) return; // 用户在翻看上面的内容：冻结输出，回到底部时再补上
                output.textContent = detail.output || (detail.status === 'running' ? '（暂无输出）' : '（没有输出）');
                if (follow) scrollToEnd();
            };

            const renderAll = () => {
                renderPicker();
                renderStatus();
                renderOutput();
                syncTicker();
            };

            const syncTicker = () => {
                // 标签藏起来时不走秒，显示回来再补
                const running = !suspended && (detail || selectedSummary())?.status === 'running';
                if (running && !ticker) ticker = win.setInterval(renderStatus, TICK_MS);
                if (!running && ticker) { win.clearInterval(ticker); ticker = null; }
            };

            const loadSelected = async () => {
                if (!selectedId) { detail = null; renderAll(); return; }
                const seq = ++loadSeq;
                const res = await api?.terminalGetCommandRun?.(selectedId);
                if (disposed || seq !== loadSeq) return;
                if (res?.success) {
                    detail = res.data;
                    loadError = '';
                } else {
                    detail = null;
                    loadError = res?.error || '读取命令输出失败';
                }
                renderAll();
            };

            // 第一次拿到列表：默认盯最新的一条（打开时指定了 runId 就用它）
            const seed = () => {
                seeded = true;
                if (!selectedSummary()) {
                    selectedId = runs[0]?.id || null;
                    manual = false;
                }
                return loadSelected();
            };

            const select = (id, isManual = true) => {
                if (!id || id === selectedId) return;
                selectedId = id;
                manual = isManual;
                follow = true;
                detail = null;
                loadError = '';
                renderAll();
                void loadSelected();
            };

            picker.addEventListener('change', () => select(picker.value));

            async function copyOutput() {
                if (!detail?.output) return;
                try {
                    await win.navigator.clipboard.writeText(detail.output);
                    toast('已复制输出', 'success');
                } catch (_e) {
                    toast('复制失败', 'error');
                }
            }

            // 数据源每次变化都给整份列表；变了的那条是新对象，其余保持原样，据此判断要不要重新读输出
            const onRuns = ({ status, data }) => {
                if (disposed) return;
                if (seeded && suspended) {
                    hiddenUpdate = { status, data };
                    return;
                }
                const previous = runs;
                runs = Array.isArray(data) ? data : [];
                if (!seeded) {
                    if (status === 'ready' || status === 'error') seeding = seed();
                    else renderPicker();
                    return;
                }
                const known = new Set(previous.map(run => run.id));
                const added = runs.find(run => !known.has(run.id));
                // 没有手动选过时，新命令一开始就自动跟过去（默认盯最新的）
                if (!manual && added && added.id !== selectedId) {
                    selectedId = added.id;
                    detail = null;
                    follow = true;
                }
                renderPicker();
                const before = previous.find(run => run.id === selectedId);
                if (selectedSummary() !== before) {
                    if (reloadTimer) win.clearTimeout(reloadTimer);
                    reloadTimer = win.setTimeout(() => { reloadTimer = null; void loadSelected(); }, 60);
                } else {
                    renderStatus();
                }
            };

            const instance = { select };
            instances.add(instance);
            requestedRunId = null;

            renderAll();
            if (commandRunsSource) {
                releaseRuns = commandRunsSource.subscribe(onRuns, { scope: viewScope, visible: occurrence?.visible, label: 'tool-output' });
                await commandRunsSource.settled();
                await seeding;
            } else {
                await seed();
            }

            return {
                focus() { output.focus?.({ preventScroll: true }); },
                suspend() {
                    suspended = true;
                    syncTicker();
                },
                resume() {
                    suspended = false;
                    if (disposed) return;
                    const update = hiddenUpdate;
                    hiddenUpdate = null;
                    if (update) onRuns(update);
                    renderAll();
                },
                dispose() {
                    disposed = true;
                    instances.delete(instance);
                    if (ticker) win.clearInterval(ticker);
                    if (reloadTimer) win.clearTimeout(reloadTimer);
                    releaseRuns?.();
                    viewElement.innerHTML = '';
                    viewElement.classList.remove('side-tool-output-view');
                }
            };
        }
    };
}
