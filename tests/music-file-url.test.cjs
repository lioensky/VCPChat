const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 封面和系统媒体控件的图都是本地缓存文件；用户名、缓存目录里带空格、#、?、'、% 时，
// 没编码的 file:// 地址会被截断或在 CSS url('…') 里断开，封面整张出不来。
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function utilsFileUrl() {
    const context = { window: {}, console, setTimeout, clearTimeout };
    vm.createContext(context);
    vm.runInContext(read('Musicmodules/music-utils.js'), context);
    const app = { api: {} };
    context.setupUtils(app);
    return app.fileUrl;
}

// 各模块自己的 fileUrl（底栏、舞台、档案页）：从源码里取出那一个箭头函数单独跑
function localFileUrl(rel) {
    const src = read(rel);
    const start = src.indexOf('const fileUrl = ');
    assert.ok(start >= 0, `${rel} has no fileUrl helper`);
    let i = src.indexOf('=>', start), depth = 0, end = -1;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{' || c === '(') depth++;
        else if (c === '}' || c === ')') depth--;
        else if (c === ';' && depth === 0) { end = j; break; }
    }
    return vm.runInNewContext(`(${src.slice(start + 'const fileUrl = '.length, end)})`);
}

const tricky = "C:\\Users\\John's PC\\AppData\\Cache #1\\a b%?.jpg";
const decoded = "/C:/Users/John's PC/AppData/Cache #1/a b%?.jpg";

const helpers = {
    'music-utils app.fileUrl': utilsFileUrl,
    'music-dock': () => localFileUrl('Musicmodules/music-dock/music-dock.js'),
    'music-stage-host': () => localFileUrl('Musicmodules/music-stage/music-stage-host.js'),
    'archive-view': () => localFileUrl('Musicmodules/music-archive/archive-view.js')
};

for (const [name, get] of Object.entries(helpers)) {
    test(`${name}: cover paths with spaces, #, ?, quotes, % and CJK become one valid file URL`, () => {
        const fileUrl = get();
        assert.equal(fileUrl(''), '');
        assert.equal(fileUrl(null), '');
        for (const p of [tricky, 'D:\\音乐\\封面 缓存\\周杰伦 - 晴天.png', '/home/u/My Music/100%.png']) {
            const url = new URL(fileUrl(p));
            assert.equal(url.protocol, 'file:');
            assert.equal(url.search, '', `${p}: query string split off`);
            assert.equal(url.hash, '', `${p}: fragment split off`);
            const expected = p.replace(/\\/g, '/');
            assert.equal(decodeURIComponent(url.pathname), expected.startsWith('/') ? expected : '/' + expected);
        }
        assert.equal(decodeURIComponent(new URL(fileUrl(tricky)).pathname), decoded);
        assert.doesNotMatch(fileUrl(tricky), /['" ]/, 'must be safe inside CSS url("…") and url(\'…\')');
    });
}
