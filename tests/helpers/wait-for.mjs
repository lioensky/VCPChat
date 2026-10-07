// Await an observable condition instead of sleeping a fixed duration. A fixed
// sleep either races the timer it waits on or wastes time on a fast runner.
export async function waitFor(predicate, { timeout = 2000, interval = 5, message = 'condition did not settle' } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}
