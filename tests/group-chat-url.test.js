const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveGroupChatUrl } = require('../Groupmodules/groupChatUrl');

test('group replies follow the VCP tool injection setting like single chat', () => {
    const url = 'http://localhost:6005/v1/chat/completions';
    assert.equal(resolveGroupChatUrl(url, true), 'http://localhost:6005/v1/chatvcp/completions');
    assert.equal(resolveGroupChatUrl(url, false), url);
    assert.equal(resolveGroupChatUrl(url, 'true'), url, 'only a real true switches, same as vcpClient');
    assert.equal(resolveGroupChatUrl(null, true), null);
    assert.equal(resolveGroupChatUrl('not a url', true), 'not a url');
});

test('both agent request sites use it; title generation and interrupt keep the plain url', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../Groupmodules/groupchat.js'), 'utf8');
    assert.equal(source.match(/fetch\(resolveGroupChatUrl\(globalVcpSettings\.vcpUrl, globalVcpSettings\.enableVcpToolInjection\)/g)?.length, 2);
    assert.equal(source.match(/fetch\(globalVcpSettings\.vcpUrl,/g), null);
    assert.match(source, /enableVcpToolInjection: settings\.enableVcpToolInjection === true/);
    assert.match(source, /urlObj\.pathname = '\/v1\/interrupt'/);
});
