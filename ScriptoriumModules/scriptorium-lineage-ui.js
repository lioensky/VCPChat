'use strict';

(() => {
    function createLineageUiController(context = {}) {
        const lineagePort = context.lineagePort;
        const documentPort = context.documentPort;
        const notificationPort = context.notificationPort || {};
        if (!lineagePort || !documentPort) {
            throw new TypeError(
                'Lineage UI requires LineageStore and DocumentPort.'
            );
        }

        let elements = context.elements || {};
        let adapter = null;
        let activeRecordId = null;
        let pendingRestoreId = null;
        let activeReviewId = null;
        let abortController = null;
        let storeDisposer = null;
        const automaticApprovalTimers = new Map();
        let autoApprovalTypesCollapsed = false;
        const avatarCache = new Map();
        let agentDirectoryPromise = null;
        let disposed = false;

        function setElements(nextElements) {
            elements = nextElements || {};
            return elements;
        }

        function setAdapter(nextAdapter) {
            if (!nextAdapter
                || typeof nextAdapter.sourceState !== 'function') {
                throw new TypeError(
                    'Lineage UI requires a document adapter.'
                );
            }
            adapter = nextAdapter;
            render();
            return adapter;
        }

        function clear() {
            if (disposed) return false;
            automaticApprovalTimers.forEach((timer) =>
                window.clearTimeout(timer)
            );
            automaticApprovalTimers.clear();
            closeDetail();
            closeReview();
            cancelRestore();
            adapter = null;
            if (elements['checkpoint-count']) {
                elements['checkpoint-count'].textContent = '0';
            }
            if (elements['pending-pr-count']) {
                elements['pending-pr-count'].textContent = '0';
            }
            if (elements['create-checkpoint-btn']) {
                elements['create-checkpoint-btn'].disabled = true;
            }
            const host = elements['lineage-flow'];
            if (host) {
                const empty = document.createElement('div');
                empty.className = 'lineage-empty';
                const title = document.createElement('strong');
                title.textContent = '文脉尚未开始';
                const message = document.createElement('p');
                message.textContent =
                    '打开或新建文档后，创作轨迹会显示在这里。';
                empty.append(title, message);
                host.replaceChildren(empty);
            }
            return true;
        }

        function currentAdapter() {
            const resolved = adapter || context.getAdapter?.();
            if (!resolved) {
                throw new Error('No document adapter is active.');
            }
            return resolved;
        }

        function authorName(record) {
            return String(
                record?.author?.name
                || record?.author?.signature
                || (record?.source === 'agent'
                    ? '未署名 Agent'
                    : '人类')
            ).trim();
        }

        function statusLabel(record) {
            const labels = {
                pending: '等待人类审阅',
                applied: record.receipt?.automatic
                    ? '自动允许并已合并'
                    : '已应用',
                rejected: '已拒绝',
                conflict: '修订冲突 · 未应用',
                failed: '应用失败',
            };
            return labels[record.status] || record.status || '已应用';
        }

        async function agentDirectory() {
            if (!agentDirectoryPromise) {
                agentDirectoryPromise = Promise.resolve(
                    context.identityPort?.loadAgentsList?.() || []
                ).then((agents) => Array.isArray(agents) ? agents : [])
                    .catch(() => []);
            }
            return agentDirectoryPromise;
        }

        async function avatarUrlFor(record) {
            const author = record?.author || {};
            const key = `${record?.source || 'human'}:${
                author.id || author.name || ''
            }`;
            if (avatarCache.has(key)) return avatarCache.get(key);
            const task = (async () => {
                if (record?.source !== 'agent') {
                    return context.identityPort?.loadUserAvatar?.() || null;
                }
                const agents = await agentDirectory();
                const authorId = String(author.id || '').trim();
                const name = authorName(record)
                    .trim()
                    .toLocaleLowerCase('zh-CN');
                const agentName = (agent) => String(agent.name || '')
                    .trim()
                    .toLocaleLowerCase('zh-CN');
                const matchedById = authorId
                    ? agents.find((agent) => String(
                        agent.folder || agent.id || ''
                    ) === authorId)
                    : null;
                const matchedByExactName = name
                    ? agents.find((agent) => agentName(agent) === name)
                    : null;
                const matchedByIncludedName = name
                    ? agents.find((agent) => {
                        const candidate = agentName(agent);
                        return candidate
                            && (
                                candidate.includes(name)
                                || name.includes(candidate)
                            );
                    })
                    : null;
                const matched = matchedById
                    || matchedByExactName
                    || matchedByIncludedName;
                const folder = matched?.folder || matched?.id || authorId;
                return folder
                    ? context.identityPort?.loadAgentAvatar?.(folder) || null
                    : null;
            })().catch(() => null);
            avatarCache.set(key, task);
            return task;
        }

        function hydrateAvatar(avatar, record) {
            avatarUrlFor(record).then((url) => {
                if (!url || !avatar.isConnected) return;
                avatar.style.backgroundImage = `url("${String(url)
                    .replace(/["\\]/g, '\\$&')}")`;
                avatar.classList.add('has-avatar');
                avatar.setAttribute(
                    'aria-label',
                    `${authorName(record)} 的头像`
                );
                avatar.setAttribute('role', 'img');
            });
        }

        function createRecordItem(record) {
            const item = document.createElement('article');
            item.className = `checkpoint-item ${
                record.source || 'human'
            } ${record.status || 'applied'}`;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');

            const meta = document.createElement('div');
            meta.className = 'checkpoint-meta';
            const identity = document.createElement('span');
            identity.className = 'checkpoint-identity';
            const avatar = document.createElement('span');
            avatar.className = `checkpoint-avatar ${
                record.source === 'agent' ? 'agent' : 'human'
            }`;
            avatar.textContent = record.source === 'agent'
                ? authorName(record).slice(0, 1).toUpperCase() || 'AI'
                : '人';
            hydrateAvatar(avatar, record);
            const source = document.createElement('span');
            source.className = 'checkpoint-source';
            source.textContent = record.source === 'agent'
                ? `AI 协作 · ${authorName(record)}`
                : `人类刻点 · ${authorName(record)}`;
            identity.append(avatar, source);
            const time = document.createElement('time');
            time.textContent = new Date(
                record.createdAt || Date.now()
            ).toLocaleString('zh-CN');
            meta.append(identity, time);

            const title = document.createElement('h3');
            title.textContent = record.name || '未命名文脉节点';
            const summary = document.createElement('p');
            summary.textContent = record.summary
                || record.note
                || '完整文档状态已记录。';
            const status = document.createElement('span');
            status.className = 'checkpoint-status';
            status.textContent = statusLabel(record);
            item.append(meta, title, summary, status);

            if (record.status === 'pending') {
                const actions = document.createElement('div');
                actions.className = 'pr-card-actions';
                const review = document.createElement('button');
                review.type = 'button';
                review.textContent = '审阅';
                review.addEventListener('click', (event) => {
                    event.stopPropagation();
                    context.reviewPort?.open?.(record);
                });
                actions.appendChild(review);
                item.appendChild(actions);
            } else if (record.status === 'conflict') {
                const actions = document.createElement('div');
                actions.className = 'pr-card-actions conflict-actions';
                const inspect = document.createElement('button');
                inspect.type = 'button';
                inspect.textContent = '查看冲突';
                inspect.addEventListener('click', (event) => {
                    event.stopPropagation();
                    openDetail(record);
                });
                actions.appendChild(inspect);
                item.appendChild(actions);
            }

            const open = () => openDetail(record);
            item.addEventListener('click', (event) => {
                if (event.target.closest('button,input,textarea,select,a')) {
                    return;
                }
                open();
            });
            item.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open();
            });
            return item;
        }

        function autoApprovalConfig() {
            return {
                enabled:
                    elements['auto-approval-enabled']?.checked === true,
                allowedTypes: new Set([
                    ...(elements['auto-approval-types']
                        ?.querySelectorAll('input:checked') || []),
                ].map((input) => input.value)),
            };
        }

        function saveAutoApprovalConfig() {
            const config = autoApprovalConfig();
            localStorage.setItem(
                'scriptorium:auto-approval',
                JSON.stringify({
                    enabled: config.enabled,
                    allowedTypes: [...config.allowedTypes],
                })
            );
        }

        function restoreAutoApprovalConfig() {
            try {
                const stored = JSON.parse(
                    localStorage.getItem(
                        'scriptorium:auto-approval'
                    ) || '{}'
                );
                if (elements['auto-approval-enabled']) {
                    elements['auto-approval-enabled'].checked =
                        stored.enabled === true;
                }
                const allowed = new Set(
                    Array.isArray(stored.allowedTypes)
                        ? stored.allowedTypes
                        : []
                );
                elements['auto-approval-types']
                    ?.querySelectorAll('input')
                    .forEach((input) => {
                        input.checked = allowed.has(input.value);
                    });
            } catch {
                if (elements['auto-approval-enabled']) {
                    elements['auto-approval-enabled'].checked = false;
                }
            }
        }

        function setAutoApprovalTypesCollapsed(collapsed, options = {}) {
            autoApprovalTypesCollapsed = collapsed === true;
            const types = elements['auto-approval-types'];
            const button = elements['auto-approval-collapse-btn'];
            if (types) types.hidden = autoApprovalTypesCollapsed;
            if (button) {
                button.setAttribute(
                    'aria-expanded',
                    String(!autoApprovalTypesCollapsed)
                );
                button.setAttribute(
                    'aria-label',
                    autoApprovalTypesCollapsed
                        ? '展开自动允许类型'
                        : '折叠自动允许类型'
                );
                button.title = autoApprovalTypesCollapsed
                    ? '展开自动允许类型'
                    : '折叠自动允许类型';
                button.classList.toggle(
                    'collapsed',
                    autoApprovalTypesCollapsed
                );
            }
            if (options.persist !== false) {
                localStorage.setItem(
                    'scriptorium:auto-approval-types-collapsed',
                    JSON.stringify(autoApprovalTypesCollapsed)
                );
            }
            return autoApprovalTypesCollapsed;
        }

        function restoreAutoApprovalTypesCollapsed() {
            try {
                setAutoApprovalTypesCollapsed(
                    JSON.parse(
                        localStorage.getItem(
                            'scriptorium:auto-approval-types-collapsed'
                        ) || 'false'
                    ) === true,
                    { persist: false }
                );
            } catch {
                setAutoApprovalTypesCollapsed(false, { persist: false });
            }
        }

        function scheduleAutoApproval(record) {
            if (record.status !== 'pending'
                || automaticApprovalTimers.has(record.id)
                || record.proposal?.programmableContent?.status === 'refuse') {
                return false;
            }
            const config = autoApprovalConfig();
            const operationType = record.proposal?.type
                || record.operation?.type
                || '';
            if (!config.enabled
                || !config.allowedTypes.has(operationType)) {
                return false;
            }
            const timer = window.setTimeout(async () => {
                automaticApprovalTimers.delete(record.id);
                const review = context.getAgentPort?.()?.review;
                if (typeof review?.approvePr !== 'function') return;
                const result = await review.approvePr(record.id, {
                    automatic: true,
                    message:
                        `已由本地自动允许策略批准 ${operationType} 操作。`,
                    policy: {
                        source: 'scriptorium-lineage-ui',
                        allowedOperationType: operationType,
                    },
                });
                if (result?.success) {
                    notificationPort.show?.(
                        '自动允许策略已合并 Agent 提案',
                        'success'
                    );
                }
                render();
            }, 0);
            automaticApprovalTimers.set(record.id, timer);
            return true;
        }

        function render() {
            if (disposed) return false;
            if (!adapter) return clear();
            const records = lineagePort.list();
            if (elements['checkpoint-count']) {
                elements['checkpoint-count'].textContent =
                    String(records.length);
            }
            if (elements['pending-pr-count']) {
                elements['pending-pr-count'].textContent = String(
                    records.filter((record) =>
                        record.status === 'pending'
                    ).length
                );
            }
            const host = elements['lineage-flow'];
            if (!host) return false;
            if (!records.length) {
                const empty = document.createElement('div');
                empty.className = 'lineage-empty';
                const title = document.createElement('strong');
                title.textContent = '文脉尚未开始';
                const message = document.createElement('p');
                message.textContent =
                    '人类与 AI 的每次共建刻点都会在这里留下轨迹。';
                empty.append(title, message);
                host.replaceChildren(empty);
                return true;
            }
            host.replaceChildren(...records.map(createRecordItem));
            records.forEach(scheduleAutoApproval);
            return true;
        }

        function detailRecord(record) {
            return {
                id: record.id,
                source: record.source,
                author: record.author || null,
                name: record.name,
                summary: record.summary || '',
                note: record.note || '',
                status: record.status || 'applied',
                baseRevision: record.baseRevision ?? null,
                revision: record.revision ?? null,
                createdAt: record.createdAt,
                receipt: record.receipt || null,
            };
        }

        function setDetailView(view = 'review') {
            const technical = view === 'technical';
            if (elements['lineage-review-view']) {
                elements['lineage-review-view'].hidden = technical;
            }
            if (elements['lineage-technical-view']) {
                elements['lineage-technical-view'].hidden = !technical;
            }
            [
                ['lineage-review-tab', !technical],
                ['lineage-technical-tab', technical],
            ].forEach(([key, active]) => {
                elements[key]?.classList.toggle('active', active);
                elements[key]?.setAttribute(
                    'aria-selected',
                    String(active)
                );
            });
            return !technical;
        }

        function openDetail(record) {
            if (!record) return false;
            activeRecordId = record.id;
            setDetailView('review');
            if (elements['lineage-detail-title']) {
                elements['lineage-detail-title'].textContent =
                    record.name || '未命名文脉节点';
            }
            if (elements['lineage-detail-meta']) {
                elements['lineage-detail-meta'].textContent = [
                    authorName(record),
                    statusLabel(record),
                    new Date(
                        record.createdAt || Date.now()
                    ).toLocaleString('zh-CN'),
                    Number.isFinite(Number(record.revision))
                        ? `修订 ${record.revision}`
                        : null,
                ].filter(Boolean).join(' · ');
            }
            context.prDiffPort?.setAdapter?.(currentAdapter());
            context.prDiffPort?.render?.(record, {
                visualHost: elements['lineage-render-diff'],
                sourceHost: elements['lineage-source-diff'],
            });
            if (elements['lineage-detail-record']) {
                elements['lineage-detail-record'].textContent =
                    JSON.stringify(detailRecord(record), null, 2);
            }
            if (elements['lineage-detail-change']) {
                elements['lineage-detail-change'].textContent =
                    JSON.stringify({
                        changeSet: record.changeSet || null,
                        proposal: record.proposal || null,
                        operation: record.operation || null,
                    }, null, 2);
            }
            const restorable = Boolean(
                typeof record.snapshot === 'string'
                && record.snapshot.trim()
                && record.status !== 'pending'
            );
            if (elements['lineage-snapshot-status']) {
                elements['lineage-snapshot-status'].textContent =
                    restorable
                        ? '工程内嵌版本快照可用'
                        : '此节点没有可用快照，仅可查看记录';
            }
            if (elements['lineage-restore-btn']) {
                elements['lineage-restore-btn'].disabled = !restorable;
            }
            if (elements['lineage-detail-dialog']) {
                elements['lineage-detail-dialog'].hidden = false;
            }
            return true;
        }

        function closeDetail() {
            activeRecordId = null;
            if (elements['lineage-detail-dialog']) {
                elements['lineage-detail-dialog'].hidden = true;
            }
        }

        function requestRestore(record = lineagePort.byId(activeRecordId)) {
            if (!record?.snapshot || record.status === 'pending') {
                return false;
            }
            pendingRestoreId = record.id;
            if (elements['lineage-restore-message']) {
                elements['lineage-restore-message'].textContent =
                    `将回溯到“${
                        record.name || record.id
                    }”。当前内容会先保存为新的工程内刻点。`;
            }
            elements['lineage-restore-dialog'].hidden = false;
            return true;
        }

        function cancelRestore() {
            pendingRestoreId = null;
            if (elements['lineage-restore-dialog']) {
                elements['lineage-restore-dialog'].hidden = true;
            }
        }

        async function confirmRestore() {
            const targetId = pendingRestoreId;
            if (!targetId) return false;
            context.editorResolver?.()?.flush?.();
            context.historyPort?.finalize?.();
            try {
                const restored = lineagePort.restore(
                    targetId,
                    currentAdapter()
                );
                if (!restored) return false;
                const nextAdapter = context.resolveAdapter?.(
                    documentPort.document()
                );
                if (nextAdapter) {
                    context.activateAdapter?.(nextAdapter);
                }
                context.renderPort?.invalidate?.('lineage-restored');
                context.renderPort?.renderEdit?.({ force: true });
                context.historyPort?.reset?.();
                closeDetail();
                cancelRestore();
                render();
                await context.persist?.('文脉版本回溯');
                notificationPort.show?.(
                    '文档版本已回溯',
                    'success',
                    4200
                );
                return true;
            } catch (error) {
                notificationPort.show?.(
                    `版本回溯失败：${error.message}`,
                    'error',
                    5000
                );
                return false;
            }
        }

        function openReview(record) {
            if (!record || record.status !== 'pending') return false;
            activeReviewId = record.id;
            const highRisk = record.proposal
                ?.programmableContent?.status === 'refuse';
            if (elements['pr-review-title']) {
                elements['pr-review-title'].textContent =
                    record.name || '协作变更审阅';
            }
            if (elements['pr-review-meta']) {
                elements['pr-review-meta'].textContent = [
                    authorName(record),
                    highRisk ? '高风险人工审阅' : statusLabel(record),
                    Number.isFinite(Number(record.baseRevision))
                        ? `基于修订 ${record.baseRevision}`
                        : null,
                ].filter(Boolean).join(' · ');
            }
            if (elements['pr-review-receipt']) {
                elements['pr-review-receipt'].value = '';
            }
            if (elements['pr-review-approve-btn']) {
                elements['pr-review-approve-btn'].textContent = highRisk
                    ? '人工确认并合并'
                    : '允许并合并';
                elements['pr-review-approve-btn'].classList.toggle(
                    'high-risk',
                    highRisk
                );
            }
            context.prDiffPort?.setAdapter?.(currentAdapter());
            context.prDiffPort?.render?.(record);
            elements['pr-review-dialog'].hidden = false;
            elements['pr-review-receipt']?.focus();
            return true;
        }

        function closeReview() {
            activeReviewId = null;
            if (elements['pr-review-dialog']) {
                elements['pr-review-dialog'].hidden = true;
            }
        }

        async function decideReview(decision) {
            if (!activeReviewId) return false;
            const review = context.getAgentPort?.()?.review;
            const method = decision === 'approve'
                ? review?.approvePr
                : review?.rejectPr;
            if (typeof method !== 'function') {
                notificationPort.show?.(
                    'Agent 审批端口尚未就绪。',
                    'error'
                );
                return false;
            }
            const result = await method(activeReviewId, {
                message: elements['pr-review-receipt']?.value || '',
            });
            closeReview();
            render();
            notificationPort.show?.(
                result?.success
                    ? 'Agent 提案已合并'
                    : result?.code === 'PR_REJECTED'
                        ? 'Agent 提案已拒绝'
                        : `Agent 提案处理失败：${
                            result?.message || '未知错误'
                        }`,
                result?.success ? 'success' : 'info',
                4200
            );
            return result;
        }

        function openCheckpointDialog() {
            if (elements['checkpoint-name-input']) {
                elements['checkpoint-name-input'].value = '';
            }
            if (elements['checkpoint-note-input']) {
                elements['checkpoint-note-input'].value = '';
            }
            elements['checkpoint-dialog'].hidden = false;
            elements['checkpoint-name-input']?.focus();
        }

        async function createCheckpoint(event) {
            event?.preventDefault?.();
            const name =
                elements['checkpoint-name-input']?.value.trim() || '';
            if (!name) return false;
            context.editorResolver?.()?.flush?.();
            context.historyPort?.finalize?.();
            lineagePort.createCheckpoint({
                name,
                note:
                    elements['checkpoint-note-input']?.value.trim() || '',
            }, currentAdapter());
            elements['checkpoint-dialog'].hidden = true;
            render();
            await context.persist?.('人类刻点');
            return true;
        }

        function bind() {
            abortController?.abort();
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            elements['create-checkpoint-btn']?.addEventListener(
                'click',
                openCheckpointDialog,
                options
            );
            elements['checkpoint-cancel-btn']?.addEventListener(
                'click',
                () => {
                    elements['checkpoint-dialog'].hidden = true;
                },
                options
            );
            elements['checkpoint-dialog']
                ?.querySelector('form')
                ?.addEventListener('submit', createCheckpoint, options);
            elements['lineage-detail-close-btn']?.addEventListener(
                'click',
                closeDetail,
                options
            );
            elements['lineage-review-tab']?.addEventListener(
                'click',
                () => setDetailView('review'),
                options
            );
            elements['lineage-technical-tab']?.addEventListener(
                'click',
                () => setDetailView('technical'),
                options
            );
            elements['lineage-restore-btn']?.addEventListener(
                'click',
                () => requestRestore(),
                options
            );
            elements['lineage-restore-cancel-btn']?.addEventListener(
                'click',
                cancelRestore,
                options
            );
            elements['lineage-restore-confirm-btn']?.addEventListener(
                'click',
                confirmRestore,
                options
            );
            elements['pr-review-close-btn']?.addEventListener(
                'click',
                closeReview,
                options
            );
            elements['pr-review-approve-btn']?.addEventListener(
                'click',
                () => decideReview('approve'),
                options
            );
            elements['pr-review-reject-btn']?.addEventListener(
                'click',
                () => decideReview('reject'),
                options
            );
            elements['pr-review-dialog']?.addEventListener(
                'click',
                (event) => {
                    if (event.target === elements['pr-review-dialog']) {
                        closeReview();
                    }
                },
                options
            );
            elements['auto-approval-collapse-btn']?.addEventListener(
                'click',
                () => setAutoApprovalTypesCollapsed(
                    !autoApprovalTypesCollapsed
                ),
                options
            );
            elements['auto-approval-enabled']?.addEventListener(
                'change',
                () => {
                    saveAutoApprovalConfig();
                    render();
                },
                options
            );
            elements['auto-approval-types']?.addEventListener(
                'change',
                () => {
                    saveAutoApprovalConfig();
                    render();
                },
                options
            );
            restoreAutoApprovalConfig();
            restoreAutoApprovalTypesCollapsed();
            storeDisposer?.();
            storeDisposer = lineagePort.subscribe(render);
            render();
            return api;
        }

        function dispose() {
            if (disposed) return;
            abortController?.abort();
            storeDisposer?.();
            automaticApprovalTimers.forEach((timer) =>
                window.clearTimeout(timer)
            );
            automaticApprovalTimers.clear();
            avatarCache.clear();
            agentDirectoryPromise = null;
            closeDetail();
            closeReview();
            cancelRestore();
            adapter = null;
            disposed = true;
        }

        const api = Object.freeze({
            setElements,
            setAdapter,
            clear,
            render,
            openDetail,
            closeDetail,
            setDetailView,
            openReview,
            closeReview,
            decideReview,
            requestRestore,
            cancelRestore,
            confirmRestore,
            createCheckpoint,
            bind,
            dispose,
        });
        return api;
    }

    window.ScriptoriumLineageUi = Object.freeze({
        createLineageUiController,
    });
})();