// No model, DOM or runtime tool leases cross this boundary.
export function createRenderWorkerClient({ createWorker, timeout = 15000, maxJobs = 32, maxChars = 2 * 1024 * 1024 } = {}) {
    let worker = null;
    let active = null;
    let disposed = false;
    let unavailable = false;
    let sequence = 0;
    let chars = 0;
    const queue = [];
    const stats = { completed: 0, cancelled: 0, failed: 0, skipped: 0 };
    function stopWorker() {
        if (worker) {
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate();
            worker = null;
        }
    }
    function settle(task, value) {
        clearTimeout(task.timer);
        chars -= task.job.text.length;
        task.resolve(value);
    }
    function fail() {
        unavailable = true;
        stopWorker();
        if (active) {
            const task = active;
            active = null;
            stats.failed++;
            settle(task, null);
        }
        while (queue.length) settle(queue.shift(), null);
    }
    function pump() {
        if (disposed || unavailable || active || !queue.length) return;
        try {
            if (!worker) {
                worker = createWorker();
                worker.onmessage = ({ data }) => {
                    if (!active || data.id !== active.id) return;
                    const task = active;
                    active = null;
                    if (data.error) stats.failed++;
                    else stats.completed++;
                    settle(task, data.error ? null : data.result);
                    pump();
                };
                worker.onerror = worker.onmessageerror = fail;
            }
            active = queue.shift();
            active.timer = setTimeout(fail, timeout);
            worker.postMessage({ id: active.id, job: active.job });
        } catch { fail(); }
    }
    return Object.freeze({
        submit(scope, job) {
            if (disposed || unavailable || !createWorker || queue.length + Number(Boolean(active)) >= maxJobs
                || typeof job.text !== 'string' || job.text.length > 512 * 1024
                || chars + job.text.length > maxChars) {
                stats.skipped++;
                return Promise.resolve(null);
            }
            // Callers supply immutable plain snapshots; clone before any queued wait.
            let snapshot;
            try { snapshot = structuredClone(job); }
            catch { stats.skipped++; return Promise.resolve(null); }
            return new Promise(resolve => {
                chars += snapshot.text.length;
                queue.push({ id: ++sequence, scope, job: snapshot, resolve, timer: null });
                pump();
            });
        },
        cancel(scope) {
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].scope !== scope) continue;
                stats.cancelled++;
                settle(queue.splice(i, 1)[0], null);
            }
            if (active?.scope === scope) {
                const task = active;
                active = null;
                stopWorker(); // interrupts synchronous parsing, not just its reply
                stats.cancelled++;
                settle(task, null);
            }
            pump();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            stopWorker();
            if (active) { settle(active, null); active = null; }
            while (queue.length) settle(queue.shift(), null);
        },
        getStats: () => ({ ...stats, pending: queue.length + Number(Boolean(active)), chars, unavailable, disposed }),
    });
}