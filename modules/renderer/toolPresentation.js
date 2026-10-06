/** Presentation only: retain protocol nodes and exact result-delete metadata.
 * Old text transcripts have no reliable call IDs. Never pair requests/results
 * by name, or report protocol block counts as completed operation counts.
 * 例外：单行合并 / 整轮折叠只把紧跟在请求后面的同名结果在视觉上并到请求那一行，
 * 两个块仍各自保留键、状态、展开记录和删除入口，计数也只数请求行。
 */
const BLOCKS = '[data-vcp-block-type="tool-use"], [data-vcp-block-type="jev-tool-use"], [data-vcp-block-type="tool-result"], [data-vcp-block-type="tool-call-summary"]';
const LABELS = { success: '成功', failed: '失败', running: '执行中', waiting: '待确认', stopped: '已停止', unknown: '状态未知', request: '请求', summary: '摘要' };
const COMMAND_LABELS = {GetCode:'读取源码', EditCode:'修改代码', CreateFile:'创建文件', ReadFile:'读取文件', UpdateTodos:'更新待办', ExecutePowerShell:'执行 PowerShell 命令', ListWorkspaces:'列出工作区', get_page_info:'读取页面信息'};
// 单行合并 / 整轮折叠：命令类别、动作词（进行中 / 已完成）和图标。
const COMMAND_KINDS = {
    GetCode:'read', ReadCode:'read', ReadFile:'read', Outline:'read', ListWorkspaces:'read', ListProjects:'read', GetProject:'read', GetNodeDiff:'read',
    SearchProjects:'search', FindSymbol:'search', Trace:'search', SearchHistory:'search',
    EditCode:'edit', CreateFile:'edit', RemoveFile:'edit', MoveFile:'edit', MoveCode:'edit', CopyCode:'edit', ResolveEdit:'edit', Rollback:'edit',
    UpdateTodos:'plan', SubmitReport:'plan',
    ExecutePowerShell:'command', StartInteractive:'command', SendInteractiveKey:'command', PasteInteractiveText:'command',
    RunInteractiveSequence:'command', QueryVisible:'command', InterruptPowerShell:'command', EndInteractive:'command',
    get_page_info:'web',
};
// [动词, 进行中, 已完成]
const KIND_WORDS = { read:['读取','正在读取','已读取'], search:['搜索','正在搜索','已搜索'], edit:['编辑','正在编辑','已编辑'], command:['执行','正在执行','已执行'], web:['浏览','正在浏览','已浏览'], media:['生成','正在生成','已生成'], plan:['更新计划','正在更新计划','已更新计划'] };
const TARGET_FIELDS = ['powershell', 'text', 'keys', 'path', 'paths', 'filePath', 'file', 'glob', 'query', 'url', 'prompt'];
const PROBLEM_LABELS = { failed: '执行失败', waiting: '待确认', stopped: '已停止', unknown: '状态未知' };
const RESULT_TEXT_KEYS = ['返回内容', '内容', 'Result', '返回结果', 'output'];
const ICONS = {
    read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    plan: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    media: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    explore: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    other: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
};
export function toolStatus(value) {
    const status = String(value || '').trim().replace(/^[✅❌⚠️\s]+/u, '').toLowerCase();
    if (['success', 'succeeded', '成功'].includes(status)) return 'success';
    if (['failed', 'failure', 'error', '失败', '错误'].includes(status)) return 'failed';
    if (['running', 'in_progress', '执行中'].includes(status)) return 'running';
    if (['pendingapproval', 'pending_approval', '待确认'].includes(status)) return 'waiting';
    if (['stopped', 'cancelled', 'canceled', '已停止', '已取消'].includes(status)) return 'stopped';
    return 'unknown';
}
function hash(value) {
    let n = 2166136261;
    for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
    return (n >>> 0).toString(36);
}
function readText(block) {
    return block.querySelector('template')?.content.textContent || block.textContent || '';
}
function firstLine(value, limit = 160) {
    const line = String(value || '').split('\n').map(s => s.trim()).find(s => s && !/^(```|~~~)/.test(s)) || '';
    return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
}
// 结果正文的第一行：失败时就是报错首行，收起状态下直接显示。
function firstBlockLine(element) {
    // Markdown 渲染后段落之间没有换行符，按块元素逐个找第一行。
    for (const node of element?.querySelectorAll('p, li, pre, h1, h2, h3, h4, h5, h6, td') || []) {
        const line = firstLine(node.textContent);
        if (line) return line;
    }
    return firstLine(element?.textContent);
}
function resultPreview(block) {
    for (const item of block.querySelectorAll('.vcp-tool-result-item')) {
        const key = item.querySelector('.vcp-tool-result-item-key')?.textContent?.replace(/[:：]\s*$/, '').trim();
        if (RESULT_TEXT_KEYS.includes(key)) return firstBlockLine(item.querySelector('.vcp-tool-result-item-value'));
    }
    return firstBlockLine(block.querySelector('.vcp-tool-result-raw-content') || block.querySelector('.vcp-tool-result-details'));
}
function isBlank(node) {
    return node.nodeType === 3 && !node.textContent.trim()
        || node.nodeType === 1 && (node.tagName === 'BR' || node.tagName === 'P' && !node.textContent.trim() && !node.children.length);
}
function nextBlock(node) {
    let next = node.nextSibling;
    while (next && isBlank(next)) next = next.nextSibling;
    return next?.nodeType === 1 ? next : null;
}
function requestSummary(block, originalName) {
    const raw = readText(block);
    // Only protocol fields at line starts; executable snippets are never parsed.
    const field = key => raw.match(new RegExp('(?:^|\\n)\\s*'+key+'\\s*:\\s*「始」([\\s\\S]*?)「末」', 'i'))?.[1]?.trim();
    const name = originalName || block.querySelector('.vcp-tool-name-highlight')?.textContent?.trim() || '工具';
    const command = field('command');
    const resource = field('path') || field('filePath');
    const knownAction = Object.hasOwn(COMMAND_LABELS, command) ? COMMAND_LABELS[command] : undefined;
    const kind = Object.hasOwn(COMMAND_KINDS, command) ? COMMAND_KINDS[command]
        : /search/i.test(name) ? 'search' : /chrome|browser|web|fetch|url/i.test(name) ? 'web' : /flux|image|draw|comfy/i.test(name) ? 'media' : 'other';
    const target = firstLine(TARGET_FIELDS.map(field).find(Boolean) || '', 180);
    return { name, action: knownAction || (command ? `${name} · ${command.slice(0, 120)}` : name), resource: resource || (knownAction ? name : ''), kind, target };
}
export function createToolPresentation({ root, getProfile }) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const roots = new WeakMap();
    const models = new WeakMap();
    const originalHeaders = new WeakMap();
    let disposed = false;
    let controlSequence = 0;
    const prefix = `vcp-tool-${hash(String(Date.now()) + String(Math.random()))}`;
    function profile(p = getProfile?.() || {}) {
        return { style: doc.documentElement.dataset.uiMode === 'next' && ['compact', 'grouped', 'inline', 'process'].includes(p.toolPresentation) ? p.toolPresentation : 'legacy', expansion: p.toolExpansion || 'attention' };
    }
    function bucket(content) {
        const owner = content.closest('.message-item') || content;
        if (!roots.has(owner)) roots.set(owner, { items: new Map(), groups: new Map() });
        return roots.get(owner);
    }
    function capture(content) {
        const state = bucket(content);
        content.querySelectorAll('[data-vcp-tool-key]').forEach(block => {
            if (block.dataset.vcpToolTouched === 'true') state.items.set(block.dataset.vcpToolKey, block.classList.contains('expanded'));
        });
        content.querySelectorAll('.vcp-tool-process').forEach(group => {
            if (group.dataset.touched === 'true') state.groups.set(group.dataset.key, group.querySelector('.vcp-tool-process-toggle').getAttribute('aria-expanded') === 'true');
        });
    }
    function unwrap(content) {
        content.querySelectorAll('.vcp-tool-process').forEach(group => {
            const body = group.querySelector(':scope > .vcp-tool-process-body');
            if (body) group.replaceWith(...body.childNodes); else group.remove();
        });
    }
    function mountRequest(block, expanded) {
        if (!block.matches('.vcp-tool-use-bubble')) return;
        const body = block.querySelector(':scope > .vcp-tool-details');
        const template = block.querySelector(':scope > .vcp-tool-details-template');
        if (!body || !template) return; // JEV has its own details lifecycle.
        if (expanded && !body.childNodes.length) body.append(template.content.cloneNode(true));
        if (!expanded) body.replaceChildren();
    }
    function setItem(block, expanded, touched = false) {
        block.classList.toggle('expanded', expanded);
        block.querySelector('.vcp-tool-row-toggle')?.setAttribute('aria-expanded', String(expanded));
        mountRequest(block, expanded);
        if (touched) block.dataset.vcpToolTouched = 'true';
        const model = models.get(block);
        if (touched && model) bucket(model.content).items.set(model.key, expanded);
    }
    function decorate(block, content, p, occurrences) {
        const kind = block.dataset.vcpBlockType;
        const result = kind === 'tool-result';
        const summary = kind === 'tool-call-summary';
        const header = block.querySelector(result ? '.vcp-tool-result-header' : summary ? '.vcp-tool-call-summary-header' : '.vcp-tool-summary');
        if (!header) return null;
        if (!originalHeaders.has(block)) originalHeaders.set(block, { nodes: [...header.childNodes], header, expanded: block.classList.contains('expanded') });
        const original = originalHeaders.get(block);
        const extraActions = [...header.children].filter(node=>!node.matches('.vcp-tool-row-toggle, .vcp-tool-result-label, .vcp-tool-result-name, .vcp-tool-result-status, .vcp-result-toggle-icon, .vcp-tool-label, .vcp-tool-name-highlight, .vcp-tool-call-summary-icon, .vcp-tool-call-summary-title'));
        // File-change badges may be installed after the first render. Keep
        // their actual nodes and handlers through future appearance previews.
        original.extraActions = extraActions;
        const name = original.nodes.find(n => n.matches?.(result ? '.vcp-tool-result-name' : '.vcp-tool-name-highlight'))?.textContent?.trim() || (summary ? '调用摘要' : '工具');
        const status = result ? toolStatus(original.nodes.find(n => n.matches?.('.vcp-tool-result-status'))?.textContent) : summary ? 'summary' : 'request';
        const fingerprint = models.get(block)?.fingerprint || (result ? block.dataset.vcpToolResultHash || hash(readText(block)) : hash(readText(block)));
        const baseKey = `${kind}:${fingerprint}`;
        const occurrence = occurrences.get(baseKey) || 0;
        occurrences.set(baseKey, occurrence + 1);
        const key = `${baseKey}:${occurrence}`;
        const state = bucket(content);
        const model = { content, key, kind, status, name, block, fingerprint };
        models.set(block, model);
        block.dataset.vcpToolKey = key;
        block.dataset.vcpToolState = status;
        clearCallMarks(block);
        block.classList.add('vcp-tool-presented');
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'vcp-tool-row-toggle';
        const chevron = doc.createElement('span');
        chevron.className = 'vcp-tool-row-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        const title = doc.createElement('span');
        title.className = 'vcp-tool-row-title';
        const request = !result && !summary ? requestSummary(block, name) : null;
        title.textContent = result ? `${name} · 结果` : summary ? '调用摘要（原始记录）' : `${request.action} · 请求`;
        const resource = doc.createElement('span');
        resource.className = 'vcp-tool-row-resource';
        resource.textContent = request?.resource?.slice(0, 180) || '';
        const stateLabel = doc.createElement('span');
        stateLabel.className = 'vcp-tool-row-state';
        stateLabel.textContent = LABELS[status];
        btn.append(chevron, title, resource, stateLabel);
        header.replaceChildren(btn);
        // Keep the real delete button, outside the disclosure button.
        original.extraActions.forEach(n => header.append(n));
        if (summary && !block.querySelector('.vcp-tool-call-summary-content')) {
            const wrapper = doc.createElement('div');
            wrapper.className = 'vcp-tool-call-summary-content';
            [...block.childNodes].filter(node=>node!==header).forEach(node=>wrapper.append(node));
            block.append(wrapper);
        }
        const body = block.querySelector(result ? '.vcp-tool-result-collapsible-content' : summary ? '.vcp-tool-call-summary-content' : '.vcp-tool-details');
        if (body) {
            body.id ||= `${prefix}-${++controlSequence}`;
            btn.setAttribute('aria-controls', body.id);
        }
        const hasRichContent = !!block.querySelector('.vcp-tool-result-image, img, audio, video, iframe, .message-attachments');
        model.rich = hasRichContent;
        let expanded = state.items.has(key) ? state.items.get(key) : p.expansion === 'all' || p.expansion === 'attention' && ['failed', 'waiting'].includes(status);
        if (hasRichContent && p.expansion !== 'none' && !state.items.has(key)) expanded = true;
        setItem(block, expanded);
        if (state.items.has(key)) block.dataset.vcpToolTouched = 'true';
        return model;
    }
    function clearCallMarks(block) {
        delete block.dataset.vcpToolKind;
        delete block.dataset.vcpToolCallState;
        delete block.dataset.vcpToolPending;
        delete block.dataset.vcpToolMerged;
    }
    function el(tag, className, text) {
        const node = doc.createElement(tag);
        node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function icon(kind, className = 'vcp-tool-row-icon') {
        const node = el('span', className);
        node.setAttribute('aria-hidden', 'true');
        // 常量 SVG，不含任何消息内容。
        node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.other}</svg>`;
        return node;
    }
    function diffStat(text) {
        const m = String(text || '').match(/\+(\d+)\s*[−-]\s*(\d+)/);
        if (!m) return null;
        const node = el('span', 'vcp-tool-row-diff');
        node.append(el('span', 'vcp-tool-row-diff-add', `+${m[1]}`), ' ', el('span', 'vcp-tool-row-diff-del', `-${m[2]}`));
        return node;
    }
    // 一次调用一行：请求 + 紧跟的同名结果；也可能只有请求（还在等结果）或只有结果。
    function renderCall(request, result, style) {
        const owner = request || result;
        const btn = owner.block.querySelector('.vcp-tool-row-toggle');
        if (!btn) return;
        const info = request ? requestSummary(request.block, request.name) : null;
        const kind = info?.kind || 'other';
        const status = result ? result.status : 'request';
        const streaming = !!owner.block.closest('.message-item.streaming');
        const words = KIND_WORDS[kind];
        const verb = !request ? result.name : !words ? info.action : result ? words[2] : streaming ? words[1] : words[0];
        const preview = result ? resultPreview(result.block) : '';
        const error = status === 'failed' ? preview : '';
        const target = request ? info.target || info.resource : preview;
        owner.block.dataset.vcpToolKind = kind;
        owner.block.dataset.vcpToolCallState = status;
        if (request && !result) owner.block.dataset.vcpToolPending = 'true';
        const diff = kind === 'edit' && status === 'success' ? diffStat(preview) : null;
        const chevron = el('span', 'vcp-tool-row-chevron');
        chevron.setAttribute('aria-hidden', 'true');
        const parts = [];
        if (style === 'inline') {
            parts.push(icon(kind), el('span', 'vcp-tool-row-title', verb));
            if (target) parts.push(el('span', 'vcp-tool-row-resource', target));
            if (diff) parts.push(diff);
            if (PROBLEM_LABELS[status]) {
                const state = el('span', 'vcp-tool-row-state', PROBLEM_LABELS[status]);
                if (error) state.title = error;
                parts.push(state);
            }
            parts.push(chevron);
        } else {
            const leading = el('span', 'vcp-tool-row-leading');
            leading.append(icon(kind), chevron);
            parts.push(leading, el('span', 'vcp-tool-row-title', request && words ? words[0] : verb));
            const summary = error || target;
            if (summary) parts.push(el('span', 'vcp-tool-row-dot'), el('span', 'vcp-tool-row-resource', summary));
            if (diff) parts.push(diff);
            if (PROBLEM_LABELS[status] && !error) parts.push(el('span', 'vcp-tool-row-state', PROBLEM_LABELS[status]));
        }
        btn.replaceChildren(...parts);
        btn.title = [info?.action, target, error].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
    }
    function presentCalls(blocks, content, style) {
        const state = bucket(content);
        for (const block of blocks) {
            const model = models.get(block);
            if (!model || model.merged || model.kind === 'tool-call-summary') continue;
            if (model.kind === 'tool-result') { renderCall(null, model, style); continue; }
            const next = nextBlock(block);
            const result = next && models.get(next);
            if (!result || result.kind !== 'tool-result' || result.name !== model.name) { renderCall(model, null, style); continue; }
            model.partner = result;
            result.partner = model;
            result.merged = true;
            next.dataset.vcpToolMerged = 'true';
            renderCall(model, result, style);
            next.querySelector('.vcp-tool-row-toggle')?.replaceChildren(el('span', 'vcp-tool-row-title', '输出'), el('span', 'vcp-tool-row-state', LABELS[result.status]));
            const ids = [block, next].map(b => b.querySelector('.vcp-tool-row-toggle')?.getAttribute('aria-controls')).filter(Boolean);
            block.querySelector('.vcp-tool-row-toggle')?.setAttribute('aria-controls', ids.join(' '));
            // 请求和结果一起开合；任一边有用户记录时以用户记录为准，否则按结果的展开规则。
            const expanded = state.items.has(model.key) ? state.items.get(model.key)
                : state.items.has(result.key) ? state.items.get(result.key) : next.classList.contains('expanded');
            setItem(block, expanded);
            setItem(next, expanded);
        }
    }
    function restore(block) {
        const original = originalHeaders.get(block);
        if (!original) return;
        original.header.replaceChildren(...original.nodes);
        original.extraActions?.filter(node=>!original.nodes.includes(node)).forEach(node=>original.header.append(node));
        const body = block.querySelector('.vcp-tool-result-collapsible-content, .vcp-tool-call-summary-content, .vcp-tool-details');
        if (body?.id?.startsWith(prefix)) body.removeAttribute('id');
        block.classList.remove('vcp-tool-presented');
        const summary = block.querySelector(':scope > .vcp-tool-call-summary-content');
        if (summary) summary.replaceWith(...summary.childNodes);
        delete block.dataset.vcpToolState;
        delete block.dataset.vcpToolKey;
        delete block.dataset.vcpToolTouched;
        clearCallMarks(block);
        setItem(block, original.expanded);
        originalHeaders.delete(block);
        models.delete(block);
    }
    function makeGroup(parent, members, content, p, options = null) {
        if (!members.length) return;
        const state = bucket(content);
        const items = members.map(node => models.get(node)).filter(Boolean);
        if (!items.length) return;
        const key = (options?.keyPrefix || '') + items[0].key;
        const counts = new Map();
        for (const m of items) counts.set(m.kind, (counts.get(m.kind) || 0) + 1);
        const stats = ['failed','waiting','running','stopped','unknown','success'].filter(s=>items.some(m=>m.status===s)).map(s=>`${items.filter(m=>m.status===s).length} ${LABELS[s]}`);
        const group = doc.createElement('section');
        group.className = 'vcp-tool-process';
        group.dataset.vcpBlockType = 'tool-process'; // Context extraction removes presentation labels too.
        group.dataset.key = key;
        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.className = 'vcp-tool-process-toggle';
        const title = doc.createElement('span');
        title.className = 'vcp-tool-process-title';
        title.textContent = `工具过程 · ${counts.get('tool-use') || counts.get('jev-tool-use') ? (counts.get('tool-use') || 0)+(counts.get('jev-tool-use') || 0)+' 请求' : ''}${counts.get('tool-result') ? ' '+counts.get('tool-result')+' 结果' : ''}`.trim();
        if (![...counts.keys()].some(k=>k!=='tool-call-summary')) title.textContent = '工具调用摘要';
        if (items.filter(m=>m.kind!=='tool-call-summary').length === 1) {
            const item = items.find(m=>m.kind!=='tool-call-summary');
            title.textContent = item.kind === 'tool-result' ? `${item.name} · 1 结果` : `${requestSummary(item.block,item.name).action} · 1 请求`;
        }
        const badge = doc.createElement('span');
        badge.className = 'vcp-tool-process-stats';
        badge.textContent = stats.join(' · ') || '可展开查看';
        const arrow = doc.createElement('span');
        arrow.className = 'vcp-tool-row-chevron';
        arrow.setAttribute('aria-hidden','true');
        toggle.append(arrow, title, badge);
        if (options) {
            group.dataset.variant = options.variant;
            title.textContent = options.title;
            badge.textContent = options.stats;
            if (options.icon) toggle.prepend(icon(options.icon));
            if (options.variant === 'turn') {
                // 整轮折叠里有正文；朗读和上下文提取会删掉整个协议块，所以只给按钮打标记。
                delete group.dataset.vcpBlockType;
                toggle.dataset.vcpBlockType = 'tool-process';
            }
        }
        const body = doc.createElement('div');
        body.className = 'vcp-tool-process-body';
        body.id = `${prefix}-${++controlSequence}`;
        toggle.setAttribute('aria-controls', body.id);
        const expanded = state.groups.has(key) ? state.groups.get(key) : options && 'expanded' in options ? options.expanded : p.expansion === 'all' || p.expansion === 'attention' && items.some(m=>['failed','waiting','running'].includes(m.status)||m.rich);
        toggle.setAttribute('aria-expanded', String(expanded));
        body.hidden = !expanded;
        group.append(toggle, body);
        parent.insertBefore(group, members[0]);
        members.forEach(node=>body.append(node));
        if (items.some(m=>m.rich)) {
            const artifact = doc.createElement('button');
            artifact.type = 'button';
            artifact.className = 'vcp-tool-process-artifact';
            artifact.textContent = '图片 / 媒体结果 · 查看';
            if (options?.variant === 'turn') artifact.dataset.vcpBlockType = 'tool-process';
            group.append(artifact);
        }
        if (state.groups.has(key)) group.dataset.touched = 'true';
    }
    function apply(content, incomingProfile) {
        if (disposed || !content) return;
        capture(content);
        unwrap(content);
        const p = profile(incomingProfile);
        content.dataset.vcpToolPresentation = p.style;
        const blocks = [...content.querySelectorAll(BLOCKS)];
        if (p.style === 'legacy') { blocks.forEach(restore); return; }
        const occurrences = new Map();
        const owner = content.closest('.message-item');
        if (owner && blocks.length) {
            for (const prior of owner.querySelectorAll(BLOCKS)) {
                if (prior === blocks[0]) break;
                const fingerprint = models.get(prior)?.fingerprint || prior.dataset.vcpToolResultHash || hash(readText(prior));
                const key = `${prior.dataset.vcpBlockType}:${fingerprint}`;
                occurrences.set(key, (occurrences.get(key) || 0) + 1);
            }
        }
        blocks.forEach(block=>decorate(block, content, p, occurrences));
        if (p.style === 'inline' || p.style === 'process') presentCalls(blocks, content, p.style);
        if (p.style === 'inline') { new Set(blocks.map(n=>n.parentElement)).forEach(parent=>groupFamilies(parent, content, p)); return; }
        if (p.style === 'process') { foldTurn(content, blocks, p); return; }
        if (p.style !== 'grouped') return;
        for (const parent of new Set(blocks.map(n=>n.parentElement))) {
            let members = [];
            const flush = ()=>{makeGroup(parent, members, content, p);members=[];};
            for (const node of [...parent.childNodes]) {
                if (models.has(node)) members.push(node);
                else if (node.nodeType === 3 && !node.textContent.trim()) { if (members.length) members.push(node); }
                else if (node.nodeType === 1 && (node.tagName === 'BR' || node.tagName === 'P' && !node.textContent.trim() && !node.children.length)) { if(members.length)members.push(node); }
                else flush(); // Text, role boundaries, widgets and other content end a group.
            }
            flush();
        }
    }
    function callStatus(model) {
        return model.partner?.status || model.status;
    }
    // 单行合并：连续的读取/搜索归成“查阅”，连续的命令归成“终端”；其他类别和正文都会打断归组。
    function groupFamilies(parent, content, p) {
        let members = [], family = null;
        const flush = () => {
            const calls = members.map(n=>models.get(n)).filter(m=>m && !m.merged);
            if (calls.length >= 2) makeGroup(parent, members, content, p, familySummary(family, calls));
            members = [];
            family = null;
        };
        for (const node of [...parent.childNodes]) {
            const model = models.get(node);
            if (model?.merged && members.length) members.push(node);
            else if (model) {
                const kind = node.dataset.vcpToolKind;
                const next = kind === 'read' || kind === 'search' ? 'explore' : kind === 'command' ? 'command' : null;
                if (!next || next !== family) flush();
                if (next) { family = next; members.push(node); }
            } else if (isBlank(node)) { if (members.length) members.push(node); }
            else flush();
        }
        flush();
    }
    function familySummary(family, calls) {
        const failed = calls.filter(m=>callStatus(m) === 'failed').length;
        const failure = failed ? `，${failed} 个失败` : '';
        if (family === 'command') return { variant: 'inline', icon: 'command', title: '终端', stats: `${calls.length} 个命令${failure}` };
        const files = calls.filter(m=>m.block.dataset.vcpToolKind === 'read').length;
        const stats = [files && `${files} 个文件`, calls.length - files && `${calls.length - files} 次搜索`].filter(Boolean).join('，');
        return { variant: 'inline', icon: 'explore', title: '查阅', stats: stats + failure };
    }
    // 整轮折叠：回复结束后，把第一个到最后一个工具块之间的过程（含中间正文）收成一行，最终回答留在外面。
    function foldTurn(content, blocks, p) {
        if (content.closest('.message-item')?.classList.contains('streaming')) return;
        const calls = blocks.map(b=>models.get(b)).filter(m=>m && !m.merged && m.kind !== 'tool-call-summary');
        if (calls.length < 2) return;
        const first = blocks[0], last = blocks[blocks.length - 1];
        if (first.parentElement !== last.parentElement) return;
        const members = [];
        for (let node = first; node; node = node.nextSibling) { members.push(node); if (node === last) break; }
        const failed = calls.filter(m=>callStatus(m) === 'failed').length;
        makeGroup(first.parentElement, members, content, p, {
            variant: 'turn', keyPrefix: 'turn:', title: `已处理 · ${calls.length} 次工具调用`, stats: failed ? `${failed} 个失败` : '',
            // 过程默认收起；只有“全部展开”或还有待确认的调用时打开。
            expanded: p.expansion === 'all' || calls.some(m=>callStatus(m) === 'waiting'),
        });
    }
    function changeGroup(group, expanded, touched = true) {
        group.querySelector('.vcp-tool-process-toggle').setAttribute('aria-expanded', String(expanded));
        group.querySelector('.vcp-tool-process-body').hidden = !expanded;
        if (touched) {
            group.dataset.touched = 'true';
            const content = group.closest('[data-vcp-tool-presentation]');
            bucket(content).groups.set(group.dataset.key, expanded);
        }
    }
    function onClick(event) {
        const btn = event.target.closest?.('.vcp-tool-row-toggle, .vcp-tool-process-toggle, .vcp-tool-process-artifact');
        if (!btn || !root.contains(btn)) return;
        event.preventDefault();
        event.stopPropagation(); // The legacy delegated header must not toggle twice.
        if (btn.classList.contains('vcp-tool-row-toggle')) {
            const block = btn.closest('[data-vcp-tool-key]');
            const expanded = !block.classList.contains('expanded');
            setItem(block, expanded, true);
            const partner = models.get(block)?.partner;
            if (partner) setItem(partner.block, expanded, true);
        } else {
            const group = btn.closest('.vcp-tool-process');
            if (btn.classList.contains('vcp-tool-process-artifact')) {
                changeGroup(group, true);
                group.querySelectorAll('[data-vcp-tool-key]').forEach(block=>{if(models.get(block)?.rich)setItem(block,true,true);});
            } else changeGroup(group, btn.getAttribute('aria-expanded') !== 'true');
        }
    }
    function refresh(event) {
        if (disposed) return;
        // Appearance publishes its event before updating getCurrent(). Use the
        // authoritative event payload so preview/cancel never lags a click.
        root.querySelectorAll('.md-content').forEach(content=>apply(content,event?.detail?.profile));
    }
    root.addEventListener('click', onClick, true);
    win.addEventListener('vcp-appearance-changed', refresh);
    return { apply, capture, dispose() {disposed=true;root.removeEventListener('click',onClick,true);win.removeEventListener('vcp-appearance-changed',refresh);} };
}
