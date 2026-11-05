'use strict';
(() => {
    function create(context) {
        let records = [];
        let queue = Promise.resolve();
        let epoch = 0;
        let metadataRevision = 0;
        const jobs = new Map();
        const settingKey = 'scriptorium.board.autoAllow';
        let autoAllow = true;
        try { autoAllow = localStorage.getItem(settingKey) !== 'false'; } catch (_) {}
        const panel = document.createElement('div');
        panel.className = 'scriptorium-board-lineage';
        panel.hidden = true;
        const header = document.createElement('div');
        const label = document.createElement('label');
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = autoAllow;
        toggle.addEventListener('change', () => {
            autoAllow = toggle.checked;
            try { localStorage.setItem(settingKey, String(autoAllow)); } catch (_) {}
            render();
        });
        label.append(toggle, ' 自动允许 Agent 修改');
        const checkpoint = document.createElement('button');
        checkpoint.type = 'button';
        checkpoint.textContent = '留下刻点';
        checkpoint.addEventListener('click', () => {
            add({ name: '手动刻点', source: 'human', status: 'applied', snapshot: context.snapshot() });
        });
        header.append(label, checkpoint);
        const list = document.createElement('div');
        panel.append(header, list);
        context.parent.append(panel);
        function touch() { metadataRevision += 1; context.changed(); }
        function publicRecord(record) {
            const { snapshot, payload, ...out } = record;
            return out;
        }
        function add(record) {
            const entry = { id: crypto.randomUUID(), createdAt: Date.now(), ...record };
            records.unshift(entry);
            touch();
            render();
            return entry;
        }
        function render() {
            list.replaceChildren();
            for (const record of records) {
                const row = document.createElement('div');
                row.className = 'scriptorium-board-lineage-row';
                const text = document.createElement('span');
                text.textContent = `${record.name || record.summary || '白板修改'} · ${record.author?.name || record.source || 'human'} · ${record.status}`;
                row.append(text);
                const action = (label, fn) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = label;
                    button.addEventListener('click', () => void Promise.resolve().then(fn).catch(context.error));
                    row.append(button);
                };
                if (record.status === 'pending') {
                    action('允许', () => approve(record.id, false));
                    action('拒绝', () => reject(record.id));
                } else if (record.snapshot && record.status === 'applied') {
                    action('回溯', () => restore(record.id));
                }
                list.append(row);
            }
        }
        function serial(fn) {
            const task = queue.catch(() => {}).then(fn);
            queue = task.catch(() => {});
            return task;
        }
        function resolveJob(record, result) {
            const job = jobs.get(record.requestId);
            job?.resolve(result);
        }
        function approve(id, automatic) {
            const expectedEpoch = epoch;
            return serial(async () => {
                const record = records.find((item) => item.id === id);
                if (!record || record.status !== 'pending') return;
                if (expectedEpoch !== epoch) throw new Error('白板已切换。');
                try {
                    if (record.baseRevision !== context.revision()) throw new Error('白板已变化，提案未合并。请读取新修订后重新提交。');
                    // 首次修改前保留原场景，确保第一笔修改也有可回溯基线。
                    if (!records.some((item) => item.snapshot)) add({
                        name: '修改前基线', source: 'human', status: 'applied', snapshot: context.snapshot(),
                    });
                    const result = await context.apply(record.payload);
                    if (expectedEpoch !== epoch) throw new Error('白板已切换。');
                    Object.assign(record, { status: 'applied', revision: context.revision(),
                        receipt: { decision: 'approved', automatic, reviewedAt: Date.now() },
                        snapshot: context.snapshot() });
                    touch();
                    if (record.payload.save !== false) {
                        const saved = await context.save();
                        result.saved = Boolean(saved);
                    }
                    resolveJob(record, { ...result, success: true, prId: record.id, status: record.status });
                    return result;
                } catch (error) {
                    if (expectedEpoch !== epoch) return;
                    const applied = record.status === 'applied';
                    record.status = applied ? 'applied' : 'conflict';
                    record.message = error.message;
                    touch();
                    resolveJob(record, { success: false, saved: false, applied, prId: record.id, status: record.status, message: error.message });
                } finally { if (expectedEpoch === epoch) render(); }
            });
        }
        function reject(id) {
            const record = records.find((item) => item.id === id);
            if (!record || record.status !== 'pending') return;
            record.status = 'rejected';
            record.receipt = { decision: 'rejected', automatic: false, reviewedAt: Date.now() };
            touch();
            resolveJob(record, { success: false, prId: id, status: 'rejected' });
            render();
        }
        function submit(payload) {
            const requestId = String(payload.requestId || '');
            if (!requestId) throw new Error('白板提案需要 requestId。');
            if (jobs.has(requestId)) return jobs.get(requestId).promise;
            const previous = records.find((record) => record.requestId === requestId);
            if (previous) return Promise.resolve({ success: previous.status === 'applied', ...publicRecord(previous), replayed: true });
            if (!payload.author?.name && !payload.maid?.name) throw new Error('白板提案需要作者署名。');
            if (!String(payload.summary || '').trim()) throw new Error('白板提案需要摘要。');
            let resolve;
            const promise = new Promise((done) => { resolve = done; });
            jobs.set(requestId, { promise, resolve });
            const record = add({ requestId, source: 'agent', author: payload.author || payload.maid,
                name: payload.summary, summary: payload.summary, status: 'pending',
                baseRevision: payload.expectedRevision, payload: JSON.parse(JSON.stringify(payload)) });
            if (autoAllow) void approve(record.id, true);
            else panel.hidden = false;
            // 待审立即回执，避免占用工具连接；之后通过历史查询状态。
            if (!autoAllow) resolve({ success: true, status: 'pending', prId: record.id, saved: false });
            return promise;
        }
        async function restore(id) {
            return serial(async () => {
                const target = records.find((record) => record.id === id);
                if (!target?.snapshot) throw new Error('刻点没有快照。');
                if (!window.confirm(`回溯到“${target.name}”？当前状态会先保留为新刻点。`)) return false;
                add({ name: '回溯前备份', source: 'human', status: 'applied', snapshot: context.snapshot() });
                await context.restore(target.snapshot);
                add({ name: `已回溯 · ${target.name}`, source: 'human', status: 'applied', snapshot: context.snapshot(),
                    operation: { type: 'restore', targetId: id } });
                return context.save();
            });
        }
        function load(value) {
            epoch += 1;
            for (const job of jobs.values()) job.resolve({ success: false, status: 'canceled', message: '白板已切换。' });
            jobs.clear();
            records = Array.isArray(value?.records) ? JSON.parse(JSON.stringify(value.records)) : [];
            // 磁盘恢复的待审提案不自动执行，防止打开外部白板即产生修改。
            for (const record of records) if (record.status === 'pending') {
                record.status = 'canceled';
                record.message = '待审提案在重新打开后已取消，请重新提交。';
            }
            metadataRevision = 0;
            panel.hidden = true;
            render();
        }
        return Object.freeze({
            load, submit, toggle: () => { panel.hidden = !panel.hidden; },
            serialize: () => ({ version: 1, records }),
            revision: () => metadataRevision,
            history: () => ({ autoAllow, records: records.map(publicRecord) }),
        });
    }
    window.ScriptoriumBoardLineage = Object.freeze({ create });
})();