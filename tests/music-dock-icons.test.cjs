// 底栏图标表里缺一个名字时，icon() 会画出一个空 svg，按钮看起来就少了箭头（比如「只看常用项」的向上箭头）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'Musicmodules', 'music-dock');

test('every icon name written in the music dock exists in the icon table', () => {
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(path.join(DIR, 'music-dock-icons.js'), 'utf8'), { window: ctx, globalThis: ctx });
    const have = ctx.MusicDockIcons || {};
    const missing = new Set();
    for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(DIR, f), 'utf8');
        for (const call of src.matchAll(/\bicon\(([^,)]*)/g)) {
            for (const m of call[1].matchAll(/'([a-z0-9-]+)'/g)) if (!have[m[1]]) missing.add(`${f}: ${m[1]}`);
        }
    }
    assert.deepEqual([...missing], []);
});
