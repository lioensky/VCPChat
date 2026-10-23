import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppearanceSideProvider } from '../modules/ui-system/side-pane/appearanceSideProvider.js';
import { defineAppearanceTabType, registerAppearanceStudioOpener } from '../modules/ui-system/side-pane/tab-types/appearance.js';

function makeStudio() {
    const calls = { mounted: [], disposed: 0 };
    let opener = null;
    return {
        calls,
        get opener() { return opener; },
        registerOpener(next) {
            opener = next;
            return () => { if (opener === next) opener = null; };
        },
        mount(host, options) {
            calls.mounted.push({ host, options });
            return { dispose() { calls.disposed += 1; } };
        }
    };
}

function makeController() {
    const calls = { opened: [], closed: [], visible: [], focused: 0 };
    return {
        calls,
        async openTab(tab) {
            calls.opened.push(tab);
            return { focus() { calls.focused += 1; } };
        },
        async closeTab(id) { calls.closed.push(id); },
        setVisible(value) { calls.visible.push(value); }
    };
}

test('the provider opens one global appearance tab and focuses it', async () => {
    const controller = makeController();
    const provider = createAppearanceSideProvider({ studio: makeStudio(), sidePaneController: controller });

    assert.equal(provider.kind, 'appearance');
    await provider.openAppearanceTab();
    assert.equal(controller.calls.opened.length, 1);
    const [tab] = controller.calls.opened;
    assert.equal(tab.id, 'side-pane-appearance');
    assert.equal(tab.kind, 'appearance');
    assert.equal(tab.scopeMode, 'global');
    assert.equal(tab.closable, true);
    assert.deepEqual(controller.calls.visible, [true]);
    assert.equal(controller.calls.focused, 1);

    await provider.closeAppearanceTab();
    assert.deepEqual(controller.calls.closed, ['side-pane-appearance']);
});

test('mountTab hands the view element to the studio and routes its close request to the tab', async () => {
    const studio = makeStudio();
    const controller = makeController();
    const provider = createAppearanceSideProvider({ studio, sidePaneController: controller });
    const view = { nodeName: 'DIV' };

    const handle = await provider.mountTab({ id: provider.tabId }, view);
    assert.equal(studio.calls.mounted.length, 1);
    assert.equal(studio.calls.mounted[0].host, view);
    await studio.calls.mounted[0].options.onRequestClose();
    assert.deepEqual(controller.calls.closed, ['side-pane-appearance']);

    handle.dispose();
    assert.equal(studio.calls.disposed, 1, 'closing the tab disposes the studio view so it can roll back its preview');
    assert.equal(await provider.mountTab({}, null), null);
});

test('without a side pane controller opening is inert instead of throwing', async () => {
    const provider = createAppearanceSideProvider({ studio: makeStudio(), sidePaneController: null });
    assert.equal(await provider.openAppearanceTab(), null);
    await provider.closeAppearanceTab();
});

test('the tab type routes the studio opener to the tab', async () => {
    const studio = makeStudio();
    const controller = makeController();
    const win = { VCPAppearanceStudio: studio };
    const type = defineAppearanceTabType({ document: null, window: win, sidePaneController: controller, uiHelper: null });

    assert.equal(type.kind, 'appearance');
    assert.equal(typeof type.provider.openAppearanceTab, 'function');

    const registration = registerAppearanceStudioOpener({ window: win, provider: type.provider });
    assert.ok(studio.opener, 'the studio routes open() through the tab type');
    await studio.opener.open();
    assert.equal(controller.calls.opened[0].id, 'side-pane-appearance');
    await studio.opener.close();
    assert.deepEqual(controller.calls.closed, ['side-pane-appearance']);

    registration.dispose();
    assert.equal(studio.opener, null);
});
