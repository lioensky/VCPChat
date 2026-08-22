import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SELECT_PROVIDER,
    createSelectProviderDecision,
    detectCustomizableNativeSelect,
    selectProviderRequest,
} from '../modules/ui-system/select-provider.js';

test('existing and owned Selects receive distinct Web Awesome providers', () => {
    assert.equal(createSelectProviderDecision({
        ownership: 'existing', webAwesomeReady: true,
    }).provider, SELECT_PROVIDER.WEB_AWESOME_PROXY);
    assert.equal(createSelectProviderDecision({
        ownership: 'owned', webAwesomeReady: true,
    }).provider, SELECT_PROVIDER.WEB_AWESOME_OWNED);
});

test('Web Awesome unavailability produces a deterministic native decision', () => {
    const decision = createSelectProviderDecision({
        ownership: 'existing', requested: 'webawesome', webAwesomeReady: false,
    });
    assert.equal(decision.provider, SELECT_PROVIDER.NATIVE);
    assert.equal(decision.reason, 'webawesome-unavailable');
    assert.equal(Object.isFrozen(decision), true);
});

test('customizable native Select is capability-gated and never assumed', () => {
    const unsupported = createSelectProviderDecision({
        requested: 'customizable-native', customizableNative: false,
    });
    const supported = createSelectProviderDecision({
        requested: 'customizable-native', customizableNative: true,
    });
    assert.equal(unsupported.provider, SELECT_PROVIDER.NATIVE);
    assert.equal(supported.provider, SELECT_PROVIDER.CUSTOMIZABLE_NATIVE);
});

test('capability detection requires both base-select and picker support', () => {
    const calls = [];
    const partial = detectCustomizableNativeSelect({
        supports(...args) {
            calls.push(args);
            return args[0] === 'appearance';
        },
    });
    assert.deepEqual(partial, { supported: false, baseSelect: true, picker: false });
    assert.deepEqual(calls, [
        ['appearance', 'base-select'],
        ['selector(::picker(select))'],
    ]);
});

test('legacy kernel option maps into the provider request without leaking policy', () => {
    assert.equal(selectProviderRequest({ kernel: 'native' }), 'native');
    assert.equal(selectProviderRequest({ kernel: 'webawesome' }), 'webawesome');
    assert.equal(selectProviderRequest({ provider: 'customizable-native' }), 'customizable-native');
    assert.equal(selectProviderRequest({}), 'auto');
});
