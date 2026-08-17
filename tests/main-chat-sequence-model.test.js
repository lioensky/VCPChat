const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SeededRandom,
    SequenceCoverage,
    createInitialModel,
    createTrace,
    minimizeFailingTrace,
    parseTrace,
    runTrace,
    serializeTrace,
} = require('./support/main-chat-sequence');

function catalog(log = []) {
    return [
        {
            id: 'select-agent',
            weight: 3,
            canRun: model => model.identity === null,
            generate: random => ({ id: `agent-${random.integer(1, 2)}` }),
            transition: (model, params) => ({ ...model, identity: { type: 'agent', id: params.id }, topicId: 'topic-1' }),
            run: async ({ params }) => { log.push(`select:${params.id}`); },
        },
        {
            id: 'type-draft',
            weight: 2,
            canRun: model => Boolean(model.identity) && model.draft.text === '',
            generate: random => ({ text: `draft-${random.integer(1, 9)}` }),
            transition: (model, params) => ({ ...model, draft: { ...model.draft, text: params.text } }),
            run: async ({ params }) => { log.push(`type:${params.text}`); },
        },
        {
            id: 'clear-draft',
            canRun: model => model.draft.text !== '',
            transition: model => ({ ...model, draft: { ...model.draft, text: '' } }),
            run: async () => { log.push('clear'); },
        },
        {
            id: 'toggle-right',
            transition: model => ({
                ...model,
                shell: { ...model.shell, right: model.shell.right === 'closed' ? 'open' : 'closed' },
            }),
            run: async () => { log.push('right'); },
        },
    ];
}

test('seeded random and generated traces are deterministic and serializable', () => {
    const firstRandom = new SeededRandom('stable');
    const secondRandom = new SeededRandom('stable');
    assert.deepEqual(
        Array.from({ length: 8 }, () => firstRandom.integer(0, 1000)),
        Array.from({ length: 8 }, () => secondRandom.integer(0, 1000)),
    );
    const first = createTrace({ seed: 'stable', steps: 20, catalog: catalog() });
    const second = createTrace({ seed: 'stable', steps: 20, catalog: catalog() });
    assert.deepEqual(first, second);
    assert.deepEqual(parseTrace(serializeTrace(first)), JSON.parse(JSON.stringify(first)));
});

test('coverage reports actions, pairs, transitions, faults and terminal outcomes deterministically', async () => {
    const actions = catalog();
    actions.find(action => action.id === 'toggle-right').fault = true;
    const coverage = new SequenceCoverage({
        requiredEdges: ['action:select-agent', 'pair:select-agent->type-draft', 'fault:toggle-right', 'outcome:completed'],
    });
    const trace = {
        version: 1,
        prng: 'mulberry32-v1',
        seed: 1,
        initialModel: createInitialModel(),
        actions: [
            { id: 'select-agent', params: { id: 'agent-1' } },
            { id: 'type-draft', params: { text: 'hello' } },
            { id: 'toggle-right', params: {} },
        ],
    };
    const result = await runTrace({ trace, catalog: actions, coverage });
    assert.deepEqual(result.coverage.actions, { 'select-agent': 1, 'toggle-right': 1, 'type-draft': 1 });
    assert.equal(result.coverage.actionPairs['select-agent->type-draft'], 1);
    assert.equal(result.coverage.faults['toggle-right'], 1);
    assert.deepEqual(result.coverage.outcomes, { completed: 1 });
    assert.deepEqual(coverage.assertRequiredEdges().missingRequiredEdges, []);
});

test('coverage merges runs and reports missing declared edges', () => {
    const aggregate = new SequenceCoverage({ requiredEdges: ['action:a', 'pair:a->b', 'outcome:completed'] });
    aggregate.merge({ actions: { a: 2 }, actionPairs: { 'a->c': 1 }, outcomes: { completed: 2 } });
    assert.deepEqual(aggregate.report().missingRequiredEdges, ['pair:a->b']);
    assert.throws(() => aggregate.assertRequiredEdges(), /pair:a->b/);
});
test('trace runner enforces preconditions, updates the model and observes every step', async () => {
    const log = [];
    const actions = catalog(log);
    const trace = createTrace({ seed: 17, steps: 12, catalog: actions });
    const observed = [];
    const result = await runTrace({
        trace,
        catalog: actions,
        observe: ({ model }) => ({ identity: model.identity, right: model.shell.right }),
        assertInvariant: ({ model, snapshot }) => {
            assert.deepEqual(snapshot.identity, model.identity);
            assert.equal(snapshot.right, model.shell.right);
        },
        onStep: ({ entry }) => observed.push(entry.id),
    });
    assert.equal(observed.length, trace.actions.length);
    assert.equal(log.length, trace.actions.length);
    assert.ok(result.model.identity);
});

test('trace minimizer removes unrelated action blocks while preserving a reproducible failure', async () => {
    const trace = {
        version: 1,
        prng: 'mulberry32-v1',
        seed: 1,
        initialModel: createInitialModel(),
        actions: [
            { id: 'noise-a', params: {} },
            { id: 'open-settings', params: {} },
            { id: 'noise-b', params: {} },
            { id: 'escape', params: {} },
            { id: 'noise-c', params: {} },
        ],
    };
    const reduced = await minimizeFailingTrace(trace, async candidate => {
        const ids = candidate.actions.map(action => action.id);
        return ids.indexOf('open-settings') >= 0 && ids.indexOf('escape') > ids.indexOf('open-settings');
    });
    assert.deepEqual(reduced.actions.map(action => action.id), ['open-settings', 'escape']);
});

test('trace runner rejects an action whose model precondition is false', async () => {
    const actions = catalog();
    const trace = {
        version: 1,
        prng: 'mulberry32-v1',
        seed: 1,
        initialModel: createInitialModel(),
        actions: [{ id: 'type-draft', params: { text: 'illegal' } }],
    };
    await assert.rejects(runTrace({ trace, catalog: actions }), /Illegal sequence action/);
});
