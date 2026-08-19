const TARGETS = Object.freeze({
    frontend: Object.freeze({
        id: 'frontend',
        tab: 'Frontend',
        title: 'VCPChat WikiBot',
        repo: 'lioensky/VCPChat',
        url: 'https://deepwiki.com/lioensky/VCPChat',
        prompts: Object.freeze([
            '解释 VCPChat 渲染器链路',
            '主聊天的状态与消息流如何组织？',
            'VCPChat 的插件前端如何加载？'
        ])
    }),
    backend: Object.freeze({
        id: 'backend',
        tab: 'Backend',
        title: 'VCPToolBox WikiBot',
        repo: 'lioensky/VCPToolBox',
        url: 'https://deepwiki.com/lioensky/VCPToolBox',
        prompts: Object.freeze([
            '解释 VCPToolBox 插件加载流程',
            'VCP 后端有哪些核心模块？',
            'OneRing 在后端如何协作？'
        ])
    }),
    fullstack: Object.freeze({
        id: 'fullstack',
        tab: 'Fullstack',
        title: 'VCP Fullstack WikiBot',
        repo: 'VCPToolBox + VCPChat',
        url: 'https://deepwiki.com/search?q=lioensky%2FVCPToolBox%20lioensky%2FVCPChat',
        prompts: Object.freeze([
            '全栈解释一次消息从前端到后端的链路',
            'VCPChat 如何调用 VCPToolBox 能力？',
            '对比两个仓库的职责边界与集成点'
        ])
    })
});

const ALLOWED_TAGS = new Set([
    'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4',
    'HR', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH',
    'THEAD', 'TR', 'UL'
]);
const DROP_CONTENT_TAGS = new Set(['IFRAME', 'OBJECT', 'SCRIPT', 'STYLE', 'TEMPLATE']);

function isSafeExternalUrl(value) {
    try {
        const url = new URL(String(value || ''), 'https://vcpchat.local/');
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function cloneSafeNode(node, outputDocument) {
    if (node.nodeType === Node.TEXT_NODE) return outputDocument.createTextNode(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tagName = node.tagName.toUpperCase();
    if (DROP_CONTENT_TAGS.has(tagName)) return null;
    if (!ALLOWED_TAGS.has(tagName)) {
        const fragment = outputDocument.createDocumentFragment();
        [...node.childNodes].forEach(child => {
            const safeChild = cloneSafeNode(child, outputDocument);
            if (safeChild) fragment.append(safeChild);
        });
        return fragment;
    }

    const element = outputDocument.createElement(tagName.toLowerCase());
    if (tagName === 'A') {
        const href = node.getAttribute('href');
        if (isSafeExternalUrl(href)) {
            element.setAttribute('href', href);
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noreferrer noopener');
        }
    } else if (tagName === 'CODE') {
        const className = node.getAttribute('class') || '';
        const languageClass = className.split(/\s+/).find(name => /^language-[\w-]+$/.test(name));
        if (languageClass) element.className = languageClass;
    }
    [...node.childNodes].forEach(child => {
        const safeChild = cloneSafeNode(child, outputDocument);
        if (safeChild) element.append(safeChild);
    });
    return element;
}

export function renderSafeMarkdown(markdown, options = {}) {
    const outputDocument = options.document || document;
    const markedInstance = options.marked || window.marked;
    const fragment = outputDocument.createDocumentFragment();
    if (!markedInstance?.parse) {
        fragment.append(outputDocument.createTextNode(String(markdown || '')));
        return fragment;
    }

    let parsed;
    try {
        parsed = markedInstance.parse(String(markdown || ''), { async: false });
    } catch {
        fragment.append(outputDocument.createTextNode(String(markdown || '')));
        return fragment;
    }
    if (typeof parsed !== 'string') {
        fragment.append(outputDocument.createTextNode(String(markdown || '')));
        return fragment;
    }

    const parsedDocument = new DOMParser().parseFromString(parsed, 'text/html');
    [...parsedDocument.body.childNodes].forEach(node => {
        const safeNode = cloneSafeNode(node, outputDocument);
        if (safeNode) fragment.append(safeNode);
    });
    return fragment;
}

function createSession(target) {
    return {
        messages: [{
            id: `${target.id}-welcome`,
            role: 'system',
            content: `已连接 ${target.repo} 的源码知识图谱。你可以询问源码结构、模块职责、调用链、渲染流程或插件机制。`
        }]
    };
}

function requestId() {
    if (globalThis.crypto?.randomUUID) return `ask-nova-${globalThis.crypto.randomUUID()}`;
    return `ask-nova-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createAskNovaController(options = {}) {
    const documentRef = options.document || document;
    const api = options.api || window.chatAPI || window.electronAPI;
    const VCPUI = options.VCPUI || window.VCPUI;
    const markedInstance = options.marked || window.marked;
    const LifecycleScope = options.LifecycleScope || window.VCPLifecycle?.LifecycleScope;
    if (!VCPUI?.create || !api?.askNovaQuery) return null;

    let activeModal = null;
    let destroyed = false;
    let openGeneration = 0;
    const controllerScope = LifecycleScope ? new LifecycleScope('next:ask-nova-controller') : null;

    async function open(targetId = 'frontend') {
        if (destroyed) return null;
        const requestGeneration = ++openGeneration;
        const initialTarget = TARGETS[targetId] || TARGETS.frontend;
        if (activeModal) {
            activeModal.switchTarget(initialTarget.id);
            activeModal.focusComposer();
            return activeModal;
        }

        // Native WebContentsViews always paint above renderer DOM. Acquire a
        // visibility lease before mounting the dialog so a recently active
        // embedded app cannot cover Ask Nova with an apparently blank page.
        const overlayOwner = Symbol('ask-nova-overlay');
        const modalScope = controllerScope?.child(`next:ask-nova-modal:${initialTarget.id}`) || null;
        try {
            await window.topTabManager?.acquireOverlay?.(overlayOwner);
        } catch (error) {
            if (modalScope) await modalScope.dispose('overlay-acquire-failed');
            throw error;
        }
        // The controller (or the whole Next presentation) may have been
        // destroyed while the native view was being hidden.  Do not attach a
        // lease to a dead owner: return it immediately instead.
        if (modalScope && !modalScope.active) {
            window.topTabManager?.releaseOverlay?.(overlayOwner);
            return null;
        }
        modalScope?.own(() => window.topTabManager?.releaseOverlay?.(overlayOwner), 'overlay-lease', 'overlay');
        if (requestGeneration !== openGeneration) {
            if (modalScope) await modalScope.dispose('superseded-open');
            else window.topTabManager?.releaseOverlay?.(overlayOwner);
            return activeModal;
        }
        if (destroyed) {
            if (modalScope) await modalScope.dispose('open-cancelled');
            else window.topTabManager?.releaseOverlay?.(overlayOwner);
            return null;
        }
        if (activeModal) {
            if (modalScope) await modalScope.dispose('duplicate-open');
            else window.topTabManager?.releaseOverlay?.(overlayOwner);
            activeModal.switchTarget(initialTarget.id);
            activeModal.focusComposer();
            return activeModal;
        }

        const sessions = Object.fromEntries(Object.values(TARGETS).map(target => [target.id, createSession(target)]));
        const state = {
            targetId: initialTarget.id,
            deepResearch: false,
            isAsking: false,
            activeRequest: null,
            closed: false,
            copiedMessageId: null
        };
        const content = documentRef.createElement('div');
        content.className = 'ask-nova-dialog';
        content.innerHTML = `
            <div class="ask-nova-toolbar">
                <div class="ask-nova-target-tabs" role="tablist" aria-label="选择源码项目"></div>
                <div class="ask-nova-toolbar-actions">
                    <button class="ask-nova-clear" type="button">清空</button>
                    <button class="ask-nova-open-external" type="button">
                        <span class="vcp-ui-icon" aria-hidden="true">external_link</span>
                        <span>DeepWiki</span>
                    </button>
                </div>
            </div>
            <div class="ask-nova-status" role="status" aria-live="polite"></div>
            <div class="ask-nova-workspace">
                <div class="ask-nova-messages" aria-live="polite"></div>
                <aside class="ask-nova-side" aria-label="Ask Nova 快捷设置">
                    <section>
                        <h3>快捷问题</h3>
                        <div class="ask-nova-prompts"></div>
                    </section>
                    <section>
                        <label class="ask-nova-deep-research">
                            <input type="checkbox">
                            <span>Deep Research</span>
                        </label>
                        <p>回答更深入，但检索时间可能更长。</p>
                    </section>
                </aside>
            </div>
            <form class="ask-nova-composer">
                <textarea rows="2" maxlength="12000" aria-label="向 Nova 提问"></textarea>
                <button type="submit">
                    <span class="vcp-ui-icon" aria-hidden="true">send</span>
                    <span>发送</span>
                </button>
            </form>`;

        const tabs = content.querySelector('.ask-nova-target-tabs');
        const status = content.querySelector('.ask-nova-status');
        const messages = content.querySelector('.ask-nova-messages');
        const prompts = content.querySelector('.ask-nova-prompts');
        const clearButton = content.querySelector('.ask-nova-clear');
        const externalButton = content.querySelector('.ask-nova-open-external');
        const deepResearchInput = content.querySelector('.ask-nova-deep-research input');
        const composer = content.querySelector('.ask-nova-composer');
        const textarea = composer.querySelector('textarea');
        const sendButton = composer.querySelector('button[type="submit"]');

        Object.values(TARGETS).forEach(target => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'ask-nova-target-tab';
            button.dataset.target = target.id;
            button.setAttribute('role', 'tab');
            button.textContent = target.tab;
            tabs.append(button);
        });

        const scopeHost = documentRef.createElement('div');
        scopeHost.className = 'vcp-ui-scope ask-nova-scope';
        let modal;
        const cleanup = () => {
            if (state.closed) return;
            state.closed = true;
            if (state.activeRequest) api.cancelAskNovaQuery?.(state.activeRequest.requestId).catch?.(() => {});
            // Sever the large dialog subtree synchronously. The controller and
            // lifecycle scope still remove their listeners below, while this
            // prevents a delayed native DOM finalizer from retaining message,
            // Markdown and form descendants as one graph.
            content.replaceChildren();
            modal?.element?.replaceChildren();
            scopeHost.replaceChildren();
            if (modalScope) {
                void modalScope.dispose('modal-closed').catch(error => {
                    console.error('[AskNova] Failed to dispose modal resources:', error);
                });
            } else {
                window.topTabManager?.releaseOverlay?.(overlayOwner);
                queueMicrotask(() => scopeHost.remove());
            }
            activeModal = null;
        };
        try {
            modal = VCPUI.create('Modal', {
                title: 'Ask Nova about VCP',
                size: 'lg',
                content,
                actions: [],
                native: true,
                closeOnBackdrop: true,
                onClose: cleanup
            });
        } catch (error) {
            if (modalScope) await modalScope.dispose('modal-create-failed');
            else window.topTabManager?.releaseOverlay?.(overlayOwner);
            throw error;
        }
        modal.element.classList.add('ask-nova-modal-host');
        if (modal.element.localName === 'wa-dialog') {
            const removeClosedHost = event => {
                if (event.target === modal.element) scopeHost.remove();
            };
            if (modalScope) modalScope.listen(modal.element, 'wa-after-hide', removeClosedHost, {}, 'wa-after-hide');
            else modal.element.addEventListener('wa-after-hide', removeClosedHost);
        }
        scopeHost.append(modal.element);
        documentRef.body.append(scopeHost);
        modalScope?.own(() => scopeHost.remove(), 'modal-host', 'dom');

        function currentTarget() {
            return TARGETS[state.targetId];
        }

        function renderMessages() {
            const session = sessions[state.targetId];
            messages.replaceChildren();
            session.messages.forEach(message => {
                const item = documentRef.createElement('article');
                item.className = `ask-nova-message ask-nova-message-${message.role}`;
                item.dataset.messageId = message.id;
                const meta = documentRef.createElement('div');
                meta.className = 'ask-nova-message-meta';
                meta.textContent = message.role === 'user' ? 'YOU' : message.role === 'assistant' ? 'VCP NOVA' : 'SYSTEM';
                const bubbleWrap = documentRef.createElement('div');
                bubbleWrap.className = 'ask-nova-message-bubble-wrap';
                const bubble = documentRef.createElement('div');
                bubble.className = 'ask-nova-message-bubble';
                bubble.append(renderSafeMarkdown(message.content, { document: documentRef, marked: markedInstance }));
                bubbleWrap.append(bubble);
                if (message.role === 'assistant') {
                    const copy = documentRef.createElement('button');
                    copy.type = 'button';
                    copy.className = 'ask-nova-copy';
                    copy.dataset.messageId = message.id;
                    copy.setAttribute('aria-label', '复制 Nova 回复');
                    copy.textContent = state.copiedMessageId === message.id ? '已复制' : '复制';
                    bubbleWrap.append(copy);
                }
                item.append(meta, bubbleWrap);
                messages.append(item);
            });
            if (state.isAsking && state.activeRequest?.targetId === state.targetId) {
                const thinking = documentRef.createElement('article');
                thinking.className = 'ask-nova-message ask-nova-message-assistant';
                thinking.innerHTML = '<div class="ask-nova-message-meta">VCP NOVA</div><div class="ask-nova-thinking"><span></span><span></span><span></span><strong>正在检索源码知识图谱...</strong></div>';
                messages.append(thinking);
            }
            messages.scrollTop = messages.scrollHeight;
        }

        function render() {
            const target = currentTarget();
            tabs.querySelectorAll('[data-target]').forEach(button => {
                const selected = button.dataset.target === state.targetId;
                button.classList.toggle('active', selected);
                button.setAttribute('aria-selected', String(selected));
            });
            const hasReplies = sessions[state.targetId].messages.some(message => message.role === 'assistant');
            status.textContent = state.isAsking
                ? `${target.title} · 正在检索源码知识图谱…`
                : `${target.title} · ${hasReplies ? '连续会话' : '新会话'}${state.deepResearch ? ' · Deep Research' : ''}`;
            prompts.replaceChildren();
            target.prompts.forEach(prompt => {
                const button = documentRef.createElement('button');
                button.type = 'button';
                button.textContent = prompt;
                button.disabled = state.isAsking;
                prompts.append(button);
            });
            textarea.placeholder = `询问 ${target.repo} 的源码细节...`;
            textarea.disabled = state.isAsking;
            composer.setAttribute('aria-busy', String(state.isAsking));
            sendButton.disabled = state.isAsking || !textarea.value.trim();
            clearButton.disabled = state.isAsking;
            deepResearchInput.disabled = state.isAsking;
            deepResearchInput.checked = state.deepResearch;
            renderMessages();
        }

        async function submitQuestion(questionValue) {
            const question = String(questionValue || '').trim();
            if (!question || state.isAsking || state.closed) return;
            const targetIdAtSubmit = state.targetId;
            const session = sessions[targetIdAtSubmit];
            const history = session.messages
                .filter(message => message.role === 'user' || message.role === 'assistant')
                .slice(-8)
                .map(message => ({ role: message.role, content: message.content }));
            session.messages.push({ id: `user-${Date.now()}`, role: 'user', content: question });
            textarea.value = '';
            state.isAsking = true;
            const activeRequest = { requestId: requestId(), targetId: targetIdAtSubmit };
            state.activeRequest = activeRequest;
            render();
            try {
                const payload = {
                    requestId: activeRequest.requestId,
                    target: targetIdAtSubmit,
                    question,
                    history,
                    deepResearch: state.deepResearch
                };
                const task = window.VCPTasks?.createTask({
                    id: activeRequest.requestId,
                    start: () => api.askNovaQuery(payload),
                    cancel: id => api.cancelAskNovaQuery?.(id),
                });
                const result = task
                    ? await task.own(modalScope, `request:${targetIdAtSubmit}`)
                    : await api.askNovaQuery(payload);
                if (state.closed || state.activeRequest !== activeRequest) return;
                if (!result?.success) {
                    if (!result?.cancelled) {
                        session.messages.push({
                            id: `error-${Date.now()}`,
                            role: 'system',
                            content: `${result?.error || 'DeepWiki 暂时不可用。'}\n\n可使用右上角 DeepWiki 按钮打开官方页面继续查询。`
                        });
                    }
                } else {
                    session.messages.push({ id: `assistant-${Date.now()}`, role: 'assistant', content: result.answer || '' });
                }
            } catch (error) {
                if (!state.closed) {
                    session.messages.push({ id: `error-${Date.now()}`, role: 'system', content: error?.message || 'DeepWiki 暂时不可用。' });
                }
            } finally {
                if (!state.closed && state.activeRequest === activeRequest) {
                    state.isAsking = false;
                    state.activeRequest = null;
                    render();
                    textarea.focus();
                }
            }
        }

        function switchTarget(nextTargetId) {
            if (!TARGETS[nextTargetId]) return;
            state.targetId = nextTargetId;
            render();
        }

        const listen = (target, type, handler, options) => {
            if (modalScope) return modalScope.listen(target, type, handler, options, `modal:${type}`);
            target.addEventListener(type, handler, options);
            return null;
        };
        listen(tabs, 'click', event => {
            const button = event.target.closest('[data-target]');
            if (button) switchTarget(button.dataset.target);
        });
        listen(prompts, 'click', event => {
            const button = event.target.closest('button');
            if (button && prompts.contains(button)) submitQuestion(button.textContent);
        });
        listen(messages, 'click', async event => {
            const button = event.target.closest('.ask-nova-copy[data-message-id]');
            if (!button || !messages.contains(button)) return;
            const messageId = button.dataset.messageId;
            const message = sessions[state.targetId].messages.find(candidate => candidate.id === messageId);
            if (!message) return;
            try {
                await navigator.clipboard.writeText(message.content);
                state.copiedMessageId = message.id;
                renderMessages();
                const resetCopied = () => {
                    if (!state.closed && state.copiedMessageId === message.id) {
                        state.copiedMessageId = null;
                        renderMessages();
                    }
                };
                if (modalScope) modalScope.timeout(resetCopied, 1600, 'copy-feedback');
                else window.setTimeout(resetCopied, 1600);
            } catch {
                window.VCPUI?.feedback?.toast?.('复制失败', { variant: 'error' });
            }
        });
        listen(clearButton, 'click', () => {
            sessions[state.targetId] = createSession(currentTarget());
            render();
            textarea.focus();
        });
        listen(externalButton, 'click', () => api.sendOpenExternalLink?.(currentTarget().url));
        listen(deepResearchInput, 'change', () => {
            state.deepResearch = deepResearchInput.checked;
            render();
        });
        listen(textarea, 'input', () => {
            sendButton.disabled = state.isAsking || !textarea.value.trim();
        });
        listen(textarea, 'keydown', event => {
            if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            composer.requestSubmit();
        });
        listen(composer, 'submit', event => {
            event.preventDefault();
            submitQuestion(textarea.value);
        });

        const instance = {
            modal,
            element: modal.element,
            close: () => modal.close(null),
            switchTarget,
            focusComposer: () => textarea.focus(),
            getState: () => ({ ...state, sessions })
        };
        activeModal = instance;
        render();
        requestAnimationFrame(() => requestAnimationFrame(() => textarea.focus()));
        return instance;
    }

    function bindTriggers(root = documentRef) {
        root.querySelectorAll('[data-ask-nova-target]').forEach(trigger => {
            if (trigger.dataset.askNovaBound === 'true') return;
            const handler = async event => {
                event.preventDefault();
                try {
                    await open(trigger.dataset.askNovaTarget);
                } catch (error) {
                    window.VCPUI?.feedback?.toast?.(error?.message || 'Ask Nova 打开失败', { variant: 'error' });
                }
            };
            trigger.dataset.askNovaBound = 'true';
            if (controllerScope) {
                controllerScope.listen(trigger, 'click', handler, undefined, 'ask-nova-trigger');
                controllerScope.own(() => {
                    delete trigger.dataset.askNovaBound;
                }, 'ask-nova-trigger-marker', 'dom-state');
            } else {
                trigger.addEventListener('click', handler);
            }
            if (!controllerScope) {
                trigger._askNovaDispose = () => {
                    trigger.removeEventListener('click', handler);
                    delete trigger._askNovaDispose;
                    delete trigger.dataset.askNovaBound;
                };
            }
        });
    }

    bindTriggers();
    return {
        open,
        bindTriggers,
        close: () => activeModal?.close(),
        destroy() {
            destroyed = true;
            openGeneration += 1;
            activeModal?.close();
            if (controllerScope) return controllerScope.dispose('controller-destroyed');
            documentRef.querySelectorAll('[data-ask-nova-bound="true"]').forEach(trigger => trigger._askNovaDispose?.());
            return Promise.resolve();
        },
        get activeModal() { return activeModal; }
    };
}

function bootstrap() {
    if (window.askNovaController) return;
    window.askNovaController = createAskNovaController();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
else bootstrap();
