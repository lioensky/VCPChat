'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let modulePromise = null;

async function loadEmoticonUrlFixerModule() {
    if (!modulePromise) {
        const source = fs.readFileSync(
            path.join(__dirname, '../modules/renderer/emoticonUrlFixer.js'),
            'utf8'
        );
        modulePromise = import(
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
        );
    }

    return modulePromise;
}

function libraryItem(category, filename) {
    return {
        category,
        filename,
        url: `https://fixture.local/pw=test/images/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`
    };
}

async function createInitializedFixer(library) {
    const { createEmoticonUrlFixer } = await loadEmoticonUrlFixerModule();
    const fixer = createEmoticonUrlFixer();

    await fixer.initialize({
        getEmoticonLibrary: async () => library
    });

    return fixer;
}

test('exact filename stem repairs an AI-invented emoticon package path', async () => {
    const expected = libraryItem('通用表情包', '喵瞪口呆猫.png');
    const fixer = await createInitializedFixer([expected]);

    const actual = fixer.fixEmoticonUrl(
        'https://fixture.local/pw=test/images/我的表情包/喵瞪口呆猫.png'
    );

    assert.equal(actual, expected.url);
});

test('file extension does not affect exact emoticon name matching', async () => {
    const expected = libraryItem('通用表情包', '喵瞪口呆猫.webp');
    const fixer = await createInitializedFixer([expected]);

    const actual = fixer.fixEmoticonUrl(
        'https://fixture.local/pw=test/images/我的表情包/喵瞪口呆猫.gif'
    );

    assert.equal(actual, expected.url);
});

test('package name is the second priority when multiple packages contain the same emoticon name', async () => {
    const general = libraryItem('通用表情包', '喵瞪口呆猫.png');
    const cat = libraryItem('猫猫表情包', '喵瞪口呆猫.gif');
    const fixer = await createInitializedFixer([general, cat]);

    const actual = fixer.fixEmoticonUrl(
        'https://fixture.local/pw=test/images/猫猫表情包/喵瞪口呆猫.webp'
    );

    assert.equal(actual, cat.url);
});

test('ambiguous exact names still fall back to a valid library image', async () => {
    const general = libraryItem('通用表情包', '喵瞪口呆猫.png');
    const cat = libraryItem('猫猫表情包', '喵瞪口呆猫.gif');
    const fixer = await createInitializedFixer([general, cat]);

    assert.equal(fixer.fixEmoticonUrl('表情包/喵瞪口呆猫.webp'), general.url);
});

test('unknown filename falls back to the closest image inside an exact package', async () => {
    const expected = libraryItem('小克表情包', '崇拜.png');
    const otherInPackage = libraryItem('小克表情包', '开心大笑.webp');
    const similarOutsidePackage = libraryItem('通用表情包', '超级崇敬.gif');
    const fixer = await createInitializedFixer([
        similarOutsidePackage,
        otherInPackage,
        expected
    ]);

    const actual = fixer.fixEmoticonUrl('images/小克表情包/超级崇拜.png');

    assert.equal(actual, expected.url);
});

test('unknown package and filename still fall back to a valid library image', async () => {
    const expected = libraryItem('通用表情包', '开心.png');
    const fixer = await createInitializedFixer([expected]);

    assert.equal(
        fixer.fixEmoticonUrl('images/虚构表情包/完全不存在.png'),
        expected.url
    );
});

test('non-emoticon image paths remain untouched', async () => {
    const expected = libraryItem('通用表情包', '喵瞪口呆猫.png');
    const fixer = await createInitializedFixer([expected]);
    const original = 'https://fixture.local/images/photos/喵瞪口呆猫.gif';

    assert.equal(fixer.fixEmoticonUrl(original), original);
});

test('rewriteServerFileKeyInUrl rewrites expired pw keys for same-host images and files', async () => {
    const { rewriteServerFileKeyInUrl } = await loadEmoticonUrlFixerModule();
    const config = {
        vcpServerUrl: 'https://vcp.example.test/v1/chat/completions',
        fileKey: 'active-fixture-key',
    };

    assert.equal(
        rewriteServerFileKeyInUrl(
            'https://vcp.example.test/pw=stale-fixture-key/images/zimageturbogen/generated.png',
            config
        ),
        'https://vcp.example.test/pw=active-fixture-key/images/zimageturbogen/generated.png'
    );

    assert.equal(
        rewriteServerFileKeyInUrl(
            'https://vcp.example.test:6005/pw=stale-fixture-key/files/report%20v2.pdf?download=1#page=2',
            config
        ),
        'https://vcp.example.test:6005/pw=active-fixture-key/files/report%20v2.pdf?download=1#page=2'
    );

    const alreadyCurrent = 'https://vcp.example.test/pw=active-fixture-key/images/persist/ok.png';
    assert.equal(rewriteServerFileKeyInUrl(alreadyCurrent, config), alreadyCurrent);
});

test('rewriteServerFileKeyInUrl never leaks fileKey to third-party hosts or unrelated paths', async () => {
    const { rewriteServerFileKeyInUrl } = await loadEmoticonUrlFixerModule();
    const config = {
        vcpServerUrl: 'https://vcp.example.test/v1/chat/completions',
        fileKey: 'secret-new-key',
    };

    const untouched = [
        'https://evil.com/pw=old/images/a.png',
        'https://sub.vcp.example.test/pw=old/images/a.png',
        'https://vcp.example.test@evil.com/pw=old/images/a.png',
        'https://evil.com&#x2f;@vcp.example.test/pw=old/images/a.png',
        'https://someone@vcp.example.test/pw=old/images/a.png',
        'file:///pw=old/images/a.png',
        'https://vcp.example.test/pw=old/admin_api/status',
        'https://vcp.example.test/api/pw=old/images/a.png',
        'https://vcp.example.test/images/a.png',
    ];

    for (const url of untouched) {
        assert.equal(rewriteServerFileKeyInUrl(url, config), url);
    }
});

test('fixer rewrites same-host keys dynamically even when emoticon library is empty', async () => {
    const { createEmoticonUrlFixer } = await loadEmoticonUrlFixerModule();
    let currentKey = 'key-v1';
    const fixer = createEmoticonUrlFixer({
        getSettings: () => ({
            vcpServerUrl: 'https://vcp.example.test/v1/chat/completions',
            fileKey: currentKey,
        }),
    });

    await fixer.initialize({
        getEmoticonLibrary: async () => [],
    });

    const stale = 'https://vcp.example.test/pw=stale-fixture-key/images/zimageturbogen/test.png';
    assert.equal(
        fixer.fixEmoticonUrl(stale),
        'https://vcp.example.test/pw=key-v1/images/zimageturbogen/test.png'
    );

    currentKey = 'key-v2';
    assert.equal(
        fixer.fixEmoticonUrl(stale),
        'https://vcp.example.test/pw=key-v2/images/zimageturbogen/test.png'
    );
});

test('fixUrlsInMarkdownText updates images, links, media tags, and bare VCP URLs without corrupting non-image emoticon links', async () => {
    const { createEmoticonUrlFixer, fixUrlsInMarkdownText } = await loadEmoticonUrlFixerModule();
    const fixer = createEmoticonUrlFixer({
        settings: {
            vcpServerUrl: 'https://vcp.example.test/v1/chat/completions',
            fileKey: 'active-key',
        },
    });
    await fixer.initialize({
        getEmoticonLibrary: async () => [
            {
                category: '通用表情包',
                filename: '开心.png',
                url: 'https://vcp.example.test:6005/pw=old-lib-key/images/%E9%80%9A%E7%94%A8%E8%A1%A8%E6%83%85%E5%8C%85/%E5%BC%80%E5%BF%83.png',
            },
        ],
    });

    const input = [
        '![图](https://vcp.example.test/pw=old/images/zimageturbogen/a.png)',
        '[文件](https://vcp.example.test/pw=old/files/spec.pdf)',
        '[网页](https://other.local/表情包/guide.html)',
        '<img src="https://vcp.example.test/pw=old/images/我的表情包/开心.png">',
        '<a href="https://vcp.example.test/pw=old/files/data.zip">zip</a>',
        '<audio src="https://vcp.example.test/pw=old/files/voice.wav"></audio>',
        '直链 https://vcp.example.test/pw=old/images/persist/b.webp',
    ].join('\n');

    const output = fixUrlsInMarkdownText(input, {
        fixEmoticonUrl: fixer.fixEmoticonUrl,
        fixServerKeyUrl: fixer.fixServerKeyUrl,
    });

    assert.match(output, /!\[图\]\(https:\/\/vcp\.example\.test\/pw=active-key\/images\/zimageturbogen\/a\.png\)/);
    assert.match(output, /\[文件\]\(https:\/\/vcp\.example\.test\/pw=active-key\/files\/spec\.pdf\)/);
    assert.match(output, /\[网页\]\(https:\/\/other\.local\/表情包\/guide\.html\)/);
    assert.match(output, /<img src="https:\/\/vcp\.example\.test:6005\/pw=active-key\/images\/%E9%80%9A%E7%94%A8%E8%A1%A8%E6%83%85%E5%8C%85\/%E5%BC%80%E5%BF%83\.png">/);
    assert.match(output, /<a href="https:\/\/vcp\.example\.test\/pw=active-key\/files\/data\.zip">zip<\/a>/);
    assert.match(output, /<audio src="https:\/\/vcp\.example\.test\/pw=active-key\/files\/voice\.wav"><\/audio>/);
    assert.match(output, /直链 https:\/\/vcp\.example\.test\/pw=active-key\/images\/persist\/b\.webp/);
});

test('fileKey remains one safe segment in Markdown links and quoted HTML attributes', async () => {
    const { rewriteServerFileKeyInUrl, fixUrlsInMarkdownText } = await loadEmoticonUrlFixerModule();
    const url = 'https://vcp.example.test/pw=old/files/clip.wav';
    const fixServerKeyUrl = value => rewriteServerFileKeyInUrl(value, {
        vcpServerUrl: 'https://vcp.example.test',
        fileKey: "quote'and(paren)/",
    });
    const fixed = 'https://vcp.example.test/pw=quote%27and%28paren%29%2F/files/clip.wav';
    assert.equal(
        fixUrlsInMarkdownText(`[clip](${url}) <audio src='${url}'></audio>`, { fixServerKeyUrl }),
        `[clip](${fixed}) <audio src='${fixed}'></audio>`
    );
});

test('clearing the live fileKey does not fall back to an earlier key', async () => {
    const { createEmoticonUrlFixer } = await loadEmoticonUrlFixerModule();
    const host = 'https://vcp.example.test';
    const url = `${host}/pw=old/images/a.png`;
    const settings = { vcpServerUrl: host, fileKey: 'active-key' };
    const fixer = createEmoticonUrlFixer({ getSettings: () => settings });
    await fixer.initialize({ loadSettings: async () => ({ ...settings }) });
    assert.equal(fixer.fixServerKeyUrl(url), `${host}/pw=active-key/images/a.png`);
    settings.fileKey = '';
    assert.equal(fixer.fixServerKeyUrl(url), url);
});
