// Declarative mount pipeline for the settings bridge domains.
//
// Each step is `{ name, before?, run }`: `before` lists the names of steps
// that must wait for this one, so the historical "this pass must own its
// nodes before the catch-all projection sees them" comments become explicit,
// machine-checked edges instead of line-position coupling.  The runner
// resolves a deterministic order (Kahn's algorithm, declaration order as the
// tie-break) and executes it; a graph without cross edges reproduces the
// declaration order exactly, which keeps the migrated sequence behaviorally
// identical by construction.

function validateSteps(steps) {
    const names = new Set();
    for (const step of steps) {
        if (!step || typeof step.name !== 'string' || !step.name || typeof step.run !== 'function') {
            throw new Error('[VCPUI SettingsPipeline] every step needs { name, run }');
        }
        if (names.has(step.name)) {
            throw new Error(`[VCPUI SettingsPipeline] duplicate step name: ${step.name}`);
        }
        names.add(step.name);
    }
    for (const step of steps) {
        for (const follower of step.before || []) {
            if (!names.has(follower)) {
                throw new Error(`[VCPUI SettingsPipeline] step "${step.name}" declares unknown follower "${follower}"`);
            }
            if (follower === step.name) {
                throw new Error(`[VCPUI SettingsPipeline] step "${step.name}" cannot precede itself`);
            }
        }
    }
}

export function resolvePipelineOrder(steps) {
    validateSteps(steps);
    const followers = new Map(steps.map(step => [step.name, []]));
    const indegree = new Map(steps.map(step => [step.name, 0]));
    for (const step of steps) {
        for (const follower of new Set(step.before || [])) {
            followers.get(step.name).push(follower);
            indegree.set(follower, indegree.get(follower) + 1);
        }
    }
    // Ready steps queue in declaration order, so independents never shuffle.
    const ready = steps.filter(step => indegree.get(step.name) === 0).map(step => step.name);
    const order = [];
    while (ready.length) {
        const name = ready.shift();
        order.push(name);
        for (const follower of followers.get(name)) {
            const left = indegree.get(follower) - 1;
            indegree.set(follower, left);
            if (left === 0) ready.push(follower);
        }
    }
    if (order.length !== steps.length) {
        const stuck = steps.map(step => step.name).filter(name => !order.includes(name));
        throw new Error(`[VCPUI SettingsPipeline] dependency cycle among: ${stuck.join(', ')}`);
    }
    return order;
}

export function runSettingsPipeline(steps, { onStep } = {}) {
    const order = resolvePipelineOrder(steps);
    const byName = new Map(steps.map(step => [step.name, step]));
    if (typeof console?.debug === 'function') {
        console.debug('[VCPUI SettingsPipeline] mount order:', order.join(' -> '));
    }
    for (const name of order) {
        try {
            byName.get(name).run();
        } catch (error) {
            // Surface the failing step by name so the caller's fallback can
            // attribute the failure and the log names the exact mount stage.
            console.error(`[VCPUI SettingsPipeline] step "${name}" failed:`, error);
            throw error;
        }
        onStep?.(name);
    }
    return order;
}
