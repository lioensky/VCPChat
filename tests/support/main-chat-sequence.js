'use strict';

const TRACE_VERSION = 1;
const PRNG_VERSION = 'mulberry32-v1';

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeSeed(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric >>> 0;
    const text = String(value ?? 'vcpchat');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

class SeededRandom {
    constructor(seed) {
        this.seed = normalizeSeed(seed);
        this.state = this.seed;
    }

    next() {
        let value = this.state += 0x6D2B79F5;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    }

    integer(minimum, maximum) {
        if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) {
            throw new RangeError('SeededRandom.integer requires an ordered integer range.');
        }
        return minimum + Math.floor(this.next() * (maximum - minimum + 1));
    }

    pick(values) {
        if (!Array.isArray(values) || values.length === 0) throw new RangeError('Cannot pick from an empty list.');
        return values[this.integer(0, values.length - 1)];
    }
}

function createInitialModel(overrides = {}) {
    return {
        boot: 'ready',
        identity: null,
        topicId: null,
        conversation: 'empty',
        messages: { durable: 0, visible: 0, hasThinking: false },
        draft: { text: '', attachments: 0 },
        shell: { left: 'expanded', right: 'closed', activeTab: 'home' },
        overlayStack: [],
        embedded: null,
        inFlight: {},
        ...clone(overrides),
    };
}

function validateCatalog(catalog) {
    if (!Array.isArray(catalog) || catalog.length === 0) throw new TypeError('Action catalog cannot be empty.');
    const ids = new Set();
    for (const action of catalog) {
        if (!action || typeof action.id !== 'string' || !action.id) throw new TypeError('Every action needs an id.');
        if (ids.has(action.id)) throw new Error(`Duplicate sequence action: ${action.id}`);
        ids.add(action.id);
        if (action.canRun && typeof action.canRun !== 'function') throw new TypeError(`${action.id}.canRun must be a function.`);
        if (action.generate && typeof action.generate !== 'function') throw new TypeError(`${action.id}.generate must be a function.`);
        if (action.transition && typeof action.transition !== 'function') throw new TypeError(`${action.id}.transition must be a function.`);
        if (action.run && typeof action.run !== 'function') throw new TypeError(`${action.id}.run must be a function.`);
    }
    return new Map(catalog.map(action => [action.id, action]));
}

function availableActions(catalog, model) {
    return catalog.filter(action => action.canRun?.(model) !== false && Number(action.weight ?? 1) > 0);
}

function chooseWeighted(random, actions) {
    const total = actions.reduce((sum, action) => sum + Number(action.weight ?? 1), 0);
    let cursor = random.next() * total;
    for (const action of actions) {
        cursor -= Number(action.weight ?? 1);
        if (cursor < 0) return action;
    }
    return actions.at(-1);
}

function createTrace({ seed, steps, initialModel = createInitialModel(), catalog }) {
    validateCatalog(catalog);
    const random = new SeededRandom(seed);
    let model = clone(initialModel);
    const actions = [];
    for (let index = 0; index < steps; index += 1) {
        const enabled = availableActions(catalog, model);
        if (!enabled.length) break;
        const definition = chooseWeighted(random, enabled);
        const params = clone(definition.generate?.(random, clone(model)) ?? {});
        actions.push({ id: definition.id, params });
        if (definition.transition) model = clone(definition.transition(clone(model), params, { predicted: true }));
    }
    return Object.freeze({
        version: TRACE_VERSION,
        prng: PRNG_VERSION,
        seed: random.seed,
        initialModel: clone(initialModel),
        actions: Object.freeze(actions.map(action => Object.freeze(action))),
    });
}

function validateTrace(trace) {
    if (!trace || trace.version !== TRACE_VERSION || trace.prng !== PRNG_VERSION) {
        throw new Error('Unsupported main-chat sequence trace format.');
    }
    if (!Array.isArray(trace.actions)) throw new TypeError('Trace actions must be an array.');
    return trace;
}

async function runTrace({ trace, catalog, driver = {}, observe, assertInvariant, onStep }) {
    validateTrace(trace);
    const definitions = validateCatalog(catalog);
    let model = clone(trace.initialModel || createInitialModel());
    const snapshots = [];
    for (let index = 0; index < trace.actions.length; index += 1) {
        const entry = trace.actions[index];
        const definition = definitions.get(entry.id);
        if (!definition) throw new Error(`Unknown sequence action at step ${index}: ${entry.id}`);
        if (definition.canRun?.(model) === false) throw new Error(`Illegal sequence action at step ${index}: ${entry.id}`);
        const before = clone(model);
        const result = await definition.run?.({ driver, model: clone(model), params: clone(entry.params), index });
        if (definition.transition) model = clone(definition.transition(clone(model), clone(entry.params), result));
        const snapshot = observe ? await observe({ driver, model: clone(model), entry, result, index }) : null;
        snapshots.push(snapshot);
        await assertInvariant?.({ driver, before, model: clone(model), snapshot, entry, result, index });
        await onStep?.({ before, model: clone(model), snapshot, entry, result, index });
    }
    return { model, snapshots };
}

async function minimizeFailingTrace(trace, stillFails) {
    validateTrace(trace);
    if (typeof stillFails !== 'function') throw new TypeError('minimizeFailingTrace requires a failure predicate.');
    let actions = [...trace.actions];
    if (!await stillFails({ ...trace, actions })) return trace;
    let granularity = 2;
    while (actions.length >= 2) {
        const chunkSize = Math.ceil(actions.length / granularity);
        let reduced = false;
        for (let start = 0; start < actions.length; start += chunkSize) {
            const candidate = [...actions.slice(0, start), ...actions.slice(start + chunkSize)];
            if (!candidate.length) continue;
            if (await stillFails({ ...trace, actions: candidate })) {
                actions = candidate;
                granularity = Math.max(2, granularity - 1);
                reduced = true;
                break;
            }
        }
        if (reduced) continue;
        if (granularity >= actions.length) break;
        granularity = Math.min(actions.length, granularity * 2);
    }
    return Object.freeze({ ...trace, actions: Object.freeze(actions.map(action => Object.freeze(clone(action)))) });
}

function serializeTrace(trace) {
    validateTrace(trace);
    return `${JSON.stringify(trace, null, 2)}\n`;
}

function parseTrace(source) {
    return validateTrace(JSON.parse(String(source)));
}

module.exports = {
    PRNG_VERSION,
    TRACE_VERSION,
    SeededRandom,
    createInitialModel,
    createTrace,
    minimizeFailingTrace,
    parseTrace,
    runTrace,
    serializeTrace,
};
