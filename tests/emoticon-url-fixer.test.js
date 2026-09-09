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