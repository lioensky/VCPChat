const sameScope = (a, b) => a && b && a.itemType === b.itemType
    && a.itemId === b.itemId && a.topicId === b.topicId;

/** Presentation only. The main-process admission service owns all mutations. */
export function createTopicAdmissionQueueView({ parent, before = null, api, getScope, notify }) {
    const doc = parent.ownerDocument;
    const root = doc.createElement('section');
    root.className = 'topic-admission-queue';
    root.setAttribute('aria-label', '暂挂消息');
    root.setAttribute('aria-live', 'polite');
    root.hidden = true;
    const style = doc.createElement('style');
    style.textContent = `
.topic-admission-queue{margin:0 0 8px;padding:8px;border:1px solid var(--border-color);border-radius:12px;background:rgba(127,127,127,.06);max-height:180px;overflow:auto}
.topic-admission-row{display:flex;align-items:center;gap:8px;padding:6px;font-size:12px}
.topic-admission-avatar{width:24px;height:24px;border-radius:50%;object-fit:cover}
.topic-admission-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topic-admission-status{color:var(--secondary-text);font-size:11px}
.topic-admission-action{border:0;border-radius:6px;background:rgba(127,127,127,.12);color:inherit;cursor:pointer;padding:3px 7px}
.topic-admission-action:disabled{opacity:.45;cursor:wait}`;
    root.append(style);
    parent.insertBefore(root, before);
    let entries = [];
    let disposed = false;
    let revision = 0;
    const pending = new Set();
    const labels = { queued: '等待入场', recovered: '等待恢复', failed: '已暂停',
        advancing: '已入场 · 推进中', uncertain: '保存待核实 · 保留占用' };

    const act = async (entry, resume) => {
        if (disposed || pending.has(entry.entryId)) return;
        pending.add(entry.entryId);
        render();
        try {
            const result = resume === 'reconcile'
                ? await api.topicAdmissionReconcile(entry.scope, entry.entryId)
                : resume
                    ? await api.topicAdmissionResume(entry.scope)
                    : await api.topicAdmissionWithdraw(entry.scope, entry.entryId);
            if (!result?.success) throw new Error(result?.error || result?.code || '操作失败');
            await refresh();
        } catch (error) {
            notify?.(error.message || String(error), 'warning');
        } finally {
            pending.delete(entry.entryId);
            render();
        }
    };
    function render() {
        if (disposed) return;
        for (const child of [...root.children]) if (child !== style) child.remove();
        const visible = entries.filter(entry => sameScope(entry.scope, getScope())
            && (['recovered', 'failed', 'uncertain'].includes(entry.state)
                || (entry.state === 'queued' && !entry.committed && entry.deferred !== false)));
        root.hidden = !visible.length;
        for (const entry of visible) {
            const row = doc.createElement('div');
            row.className = 'topic-admission-row';
            if (entry.message.avatarUrl) {
                const avatar = doc.createElement('img');
                avatar.className = 'topic-admission-avatar';
                avatar.src = entry.message.avatarUrl;
                avatar.alt = '';
                row.append(avatar);
            }
            const label = doc.createElement('span');
            label.className = 'topic-admission-label';
            const content = typeof entry.message.content === 'string'
                ? entry.message.content : entry.message.content?.text || '';
            label.textContent = `${entry.message.name || '用户'}：${content || '附件消息'}`;
            label.title = label.textContent;
            const status = doc.createElement('span');
            status.className = 'topic-admission-status';
            status.textContent = labels[entry.state] || entry.state;
            status.title = entry.error || status.textContent;
            row.append(label, status);
            if (entry.state === 'uncertain' && typeof api.topicAdmissionReconcile === 'function') {
                const verify = doc.createElement('button');
                verify.type = 'button';
                verify.className = 'topic-admission-action';
                verify.textContent = '核对终稿';
                verify.title = '仅核对已保存终稿；不重新生成，不清除活动租约';
                verify.disabled = pending.has(entry.entryId);
                verify.addEventListener('click', () => { void act(entry, 'reconcile'); });
                row.append(verify);
            }
            if (['recovered', 'failed'].includes(entry.state)) {
                const resume = doc.createElement('button');
                resume.type = 'button';
                resume.className = 'topic-admission-action';
                resume.textContent = '继续';
                resume.disabled = pending.has(entry.entryId);
                resume.addEventListener('click', () => { void act(entry, true); });
                row.append(resume);
            }
            if (!entry.committed && !entry.commitStarted) {
                const cancel = doc.createElement('button');
                cancel.type = 'button';
                cancel.className = 'topic-admission-action';
                cancel.textContent = '×';
                cancel.setAttribute('aria-label', '撤回暂挂消息');
                cancel.title = '撤回暂挂消息';
                cancel.disabled = pending.has(entry.entryId);
                cancel.addEventListener('click', () => { void act(entry, false); });
                row.append(cancel);
            }
            root.append(row);
        }
    }
    async function refresh() {
        const generation = ++revision;
        const result = await api.topicAdmissionList();
        if (disposed || generation !== revision) return;
        if (!result?.success) throw new Error(result?.error || '无法读取暂挂队列');
        entries = result.entries;
        render();
    }
    const unsubscribe = api.onTopicAdmissionChanged(next => {
        if (disposed) return;
        ++revision;
        entries = next;
        render();
    });
    return {
        refresh,
        selectionChanged: render,
        dispose() {
            disposed = true;
            ++revision;
            unsubscribe?.();
            root.remove();
        },
    };
}