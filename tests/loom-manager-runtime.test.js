'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

class FakeSession extends EventEmitter {
    setPermissionCheckHandler(handler) {
        this.permissionCheckHandler = handler;
    }

    setPermissionRequestHandler(handler) {
        this.permissionRequestHandler = handler;
    }

    setDevicePermissionHandler(handler) {
        this.devicePermissionHandler = handler;
    }
}

function createElectronMock(dialogResponses) {
    return {
        BrowserWindow: {
            getAllWindows: () => [],
        },
        WebContentsView: class {},
        ipcMain: {
            removeHandler() {},
            handle() {},
        },
        session: {
            fromPartition: () => new FakeSession(),
        },
        app: {},
        dialog: {
            async showMessageBox(_window, options) {
                dialogResponses.push(options);
                return { response: 0 };
            },
        },
        shell: {},
    };
}

async function withElectronMock(callback) {
    const dialogResponses = [];
    const originalLoad = Module._load;
    const managerPath = require.resolve('../modules/loom/VCPLoomManager');

    Module._load = function mockLoad(request, parent, isMain) {
        if (request === 'electron') return createElectronMock(dialogResponses);
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[managerPath];

    try {
        const managerModule = require(managerPath);
        await callback(managerModule, dialogResponses);
    } finally {
        delete require.cache[managerPath];
        Module._load = originalLoad;
    }
}

function createHardwareInstance(fakeSession) {
    const contents = Object.assign(new EventEmitter(), {
        session: fakeSession,
        destroyed: false,
        isDestroyed() {
            return this.destroyed;
        },
        getURL() {
            return 'https://hub.example/device';
        },
    });
    return {
        appId: 'keyboard-hub',
        manifest: {
            id: 'keyboard-hub',
            name: 'Keyboard Hub',
            startUrl: 'https://hub.example/',
        },
        window: {},
        view: { webContents: contents },
        devicePermissionGrants: [],
        pendingDeviceSelections: new Map(),
        devicePermissionCleanup: null,
    };
}

async function testInitializeLock(VCPLoomManager) {
    const manager = new VCPLoomManager();
    let reloadCount = 0;
    let registerCount = 0;
    let releaseReload;

    manager.reloadRegistry = async () => {
        reloadCount += 1;
        await new Promise((resolve) => {
            releaseReload = resolve;
        });
        return [];
    };
    manager.registerIpc = () => {
        registerCount += 1;
    };

    const first = manager.initialize();
    const second = manager.initialize();
    const waitStartedAt = Date.now();
    while (reloadCount === 0 && Date.now() - waitStartedAt < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.strictEqual(reloadCount, 1, '并发 initialize() 必须共享同一初始化任务');
    releaseReload();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.strictEqual(firstResult, manager);
    assert.strictEqual(secondResult, manager);
    assert.strictEqual(registerCount, 1);
    assert.strictEqual(manager.initialized, true);
}
async function testGenericDeviceBroker(VCPLoomManager, dialogResponses) {
    const manager = new VCPLoomManager();
    const fakeSession = new FakeSession();
    const instance = createHardwareInstance(fakeSession);
    const shellEvents = [];
    let persistedCount = 0;
    let releasePersistence;
    manager.sendToShell = (_instance, channel, payload) => {
        shellEvents.push([channel, payload]);
    };
    manager.saveDevicePermissionGrants = async () => {
        persistedCount += 1;
        await new Promise((resolve) => {
            releasePersistence = resolve;
        });
    };
    manager.configureDevicePermissionBroker(instance);

    for (const eventName of ['select-hid-device', 'select-usb-device', 'select-serial-port']) {
        assert.strictEqual(
            fakeSession.listenerCount(eventName),
            1,
            `${eventName} 必须由通用 Session 设备代理监听`
        );
    }
    assert.strictEqual(
        instance.view.webContents.listenerCount('select-bluetooth-device'),
        1,
        '蓝牙选择必须由通用设备代理监听在 WebContents'
    );
    assert.strictEqual(
        fakeSession.permissionCheckHandler(null, 'hid', 'https://hub.example'),
        true
    );
    assert.strictEqual(
        fakeSession.permissionCheckHandler(null, 'hid', 'https://evil.example'),
        false
    );

    let prevented = false;
    let selectedDeviceId;
    const selectionFinished = new Promise((resolve) => {
        fakeSession.emit(
            'select-hid-device',
            {
                preventDefault() {
                    prevented = true;
                },
            },
            {
                deviceList: [],
                frameOrigin: 'https://hub.example',
            },
            (deviceId) => {
                selectedDeviceId = deviceId;
                resolve();
            }
        );
    });

    assert.strictEqual(prevented, true);
    assert.strictEqual(
        selectedDeviceId,
        undefined,
        '初始空列表不能立刻取消 requestDevice()'
    );

    const hidDevice = {
        deviceId: 'generic-hid-device',
        productName: 'Generic HID Device',
        vendorId: 0x1234,
        productId: 0x5678,
        serialNumber: 'TEST-001',
        collections: [{ usagePage: 1, usage: 6 }],
    };
    fakeSession.emit('hid-device-added', {}, hidDevice);

    assert.strictEqual(
        selectedDeviceId,
        undefined,
        '发现候选设备后必须等待壳菜单中的用户选择'
    );
    const candidateEvent = shellEvents.find(([channel, payload]) =>
        channel === 'loom:device-candidates'
        && payload.protocol === 'hid'
        && payload.devices.length === 1
    );
    assert(candidateEvent, '候选设备必须推送到 Loom 壳');
    assert.strictEqual(candidateEvent[1].devices[0].name, 'Generic HID Device');
    assert(candidateEvent[1].devices[0].detail.includes('VID 1234'));
    assert(candidateEvent[1].devices[0].detail.includes('PID 5678'));

    const selectPromise = manager.selectDeviceFromShell(instance, {
        protocol: 'hid',
        deviceId: 'generic-hid-device',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
        selectedDeviceId,
        undefined,
        '授权文件落盘前不得向 Chromium 提交设备选择'
    );
    assert.strictEqual(persistedCount, 1);
    releasePersistence();
    const selected = await selectPromise;
    assert.strictEqual(selected.connected, true);
    await selectionFinished;
    assert.strictEqual(selectedDeviceId, 'generic-hid-device');
    assert.strictEqual(instance.devicePermissionGrants.length, 1);
    assert.strictEqual(
        fakeSession.devicePermissionHandler({
            deviceType: 'hid',
            origin: 'https://hub.example',
            device: {
                deviceId: 'new-enumeration-id',
                vendorId: hidDevice.vendorId,
                productId: hidDevice.productId,
                serialNumber: hidDevice.serialNumber,
            },
        }),
        true,
        '刷新或重启后必须忽略临时 deviceId 以及可能缺失的名称和 collections'
    );
    assert.strictEqual(
        fakeSession.devicePermissionHandler({
            deviceType: 'hid',
            origin: 'https://evil.example',
            device: hidDevice,
        }),
        false,
        '设备授权不得跨 origin 分发'
    );
    assert.strictEqual(dialogResponses.length, 0, '设备选择不得使用 Windows 原生对话框');
    assert.strictEqual(
        fakeSession.permissionCheckHandler(null, 'usb', 'https://hub.example'),
        true
    );
    assert.strictEqual(
        fakeSession.permissionCheckHandler(null, 'serial', 'https://hub.example'),
        true
    );

    manager.saveDevicePermissionGrants = async () => {
        persistedCount += 1;
    };
    fakeSession.emit('hid-device-revoked', {}, {
        origin: 'https://hub.example',
        device: hidDevice,
    });
    assert.strictEqual(instance.devicePermissionGrants.length, 0);
    assert(persistedCount >= 2);

    instance.devicePermissionCleanup();
    for (const eventName of ['select-hid-device', 'select-usb-device', 'select-serial-port']) {
        assert.strictEqual(fakeSession.listenerCount(eventName), 0);
    }
    assert.strictEqual(
        instance.view.webContents.listenerCount('select-bluetooth-device'),
        0
    );
    assert.strictEqual(fakeSession.listenerCount('hid-device-added'), 0);
    assert.strictEqual(fakeSession.listenerCount('hid-device-removed'), 0);
}

async function testDeviceRequestDoesNotReload(VCPLoomManager) {
    const manager = new VCPLoomManager();
    const shellEvents = [];
    let reloadCount = 0;
    const contents = {
        isDestroyed: () => false,
        executeJavaScript: async () => ({
            confirmed: true,
            count: 1,
            name: 'Aurora80 RGB',
        }),
        reload() {
            reloadCount += 1;
        },
    };
    const instance = {
        view: { webContents: contents },
    };
    manager.sendToShell = (_instance, channel, payload) => {
        shellEvents.push([channel, payload]);
    };

    assert.deepStrictEqual(
        manager.requestDeviceFromShell(instance, 'hid'),
        { pending: true, protocol: 'hid' }
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(
        reloadCount,
        0,
        '授权完成后 Loom 不得二次刷新厂商控制页并销毁刚打开的设备句柄'
    );
    assert(shellEvents.some(([channel, payload]) =>
        channel === 'loom:device-candidates'
        && payload.connected === true
        && payload.name === 'Aurora80 RGB'
    ));
}

function testLegacyDeviceFingerprintMigration(VCPLoomManager) {
    const manager = new VCPLoomManager();
    const legacyFingerprint = JSON.stringify({
        type: 'hid',
        vendorId: 0x1234,
        productId: 0x5678,
        serialNumber: 'TEST-001',
        name: '旧枚举名称',
        collections: [{ usagePage: 1, usage: 6 }],
    });

    assert.strictEqual(
        manager.normalizeStoredDeviceFingerprint('hid', legacyFingerprint),
        manager.deviceFingerprint('hid', {
            vendorId: 0x1234,
            productId: 0x5678,
            serialNumber: 'TEST-001',
        }),
        '旧版授权指纹必须迁移为不依赖名称与 collections 的稳定格式'
    );
}

function testDetachedDevTools(VCPLoomManager) {
    const manager = new VCPLoomManager();
    const calls = [];
    const contents = {
        opened: false,
        isDestroyed: () => false,
        isDevToolsOpened() {
            return this.opened;
        },
        openDevTools(options) {
            calls.push(['open', options]);
            this.opened = true;
        },
        closeDevTools() {
            calls.push(['close']);
            this.opened = false;
        },
    };
    const win = {
        isDestroyed: () => false,
    };
    manager.instances.set('keyboard-hub', {
        window: win,
        view: { webContents: contents },
    });

    assert.strictEqual(manager.toggleDevToolsForWindow(win), true);
    assert.deepStrictEqual(calls[0], ['open', { mode: 'detach', activate: true }]);
    assert.strictEqual(manager.toggleDevToolsForWindow(win), true);
    assert.deepStrictEqual(calls[1], ['close']);
}

async function run() {
    await withElectronMock(async ({ VCPLoomManager }, dialogResponses) => {
        await testInitializeLock(VCPLoomManager);
        await testGenericDeviceBroker(VCPLoomManager, dialogResponses);
        await testDeviceRequestDoesNotReload(VCPLoomManager);
        testLegacyDeviceFingerprintMigration(VCPLoomManager);
        testDetachedDevTools(VCPLoomManager);
    });
    console.log('loom-manager-runtime.test.js: all assertions passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});