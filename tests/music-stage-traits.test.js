// 舞台模式外观特性只在登记表里写一份；这里核对它和以前宿主/开场里写死的名单完全一致。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage', f), 'utf8');

function load() {
    const stub = { create() { return {}; } };
    const window = {};
    for (const name of ['Tempera', 'Sonnet', 'Diorama', 'Fume', 'Tunnel', 'Kowloon', 'Inkdraft', 'Fogpane', 'Lumiere',
        'Hanabi', 'Clockwork', 'Orbit', 'Signal', 'Groupchat', 'Impression', 'Luminous', 'Partita', 'Cadenza']) {
        window[`MusicStage${name}Manager`] = stub;
    }
    window.MusicStageModeUtils = { seededRandom: () => () => 0, hashString: () => 0, splitGraphemes: (s) => [...s],
        createElement: () => ({}), makeModeBase: () => ({}), getLineKey: () => '' };
    vm.runInNewContext(read('music-stage-advanced-modes.js'), { window });
    vm.runInNewContext(read('music-stage-modes.js'), { window, Map, Set, Object, Error, Math, String, Number, Array });
    return window.MusicStageModes;
}

test('traits match the lists the host and intro used to hard-code', () => {
    const Modes = load();
    const ids = ['luminous', 'partita', 'cadenza', 'tempera', 'sonnet', 'diorama', 'fume', 'tunnel', 'kowloon', 'inkdraft',
        'fogpane', 'lumiere', 'hanabi', 'clockwork', 'orbit', 'signal', 'groupchat', 'impression', 'starborn', 'unknown'];
    const scene3d = ['diorama', 'tunnel', 'kowloon'];
    const opaque = ['inkdraft', 'fogpane', 'lumiere', 'hanabi', 'clockwork', 'orbit', 'signal', 'groupchat', 'impression'];
    const night = ['fogpane', 'lumiere', 'hanabi'];
    for (const id of ids) {
        const t = Modes.traits(id);
        assert.equal(t.scene3d, scene3d.includes(id), `${id} scene3d`);
        assert.equal(t.scene3d || t.opaque, scene3d.includes(id) || opaque.includes(id), `${id} opaque`);
        assert.equal(t.night, night.includes(id), `${id} night`);
    }
});
