const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveGroupChatUrl } = require('../Groupmodules/groupChatUrl');

test('group replies follow the VCP tool injection setting like single chat', () => {
    const root = 'http://localhost:6005';
    const url = `${root}/v1/chat/completions`;
    assert.equal(resolveGroupChatUrl(root, false), url);
    assert.equal(resolveGroupChatUrl(root, true), `${root}/v1/chatvcp/completions`);
    assert.equal(resolveGroupChatUrl(url, true), 'http://localhost:6005/v1/chatvcp/completions');
    assert.equal(resolveGroupChatUrl(url, false), url);
    assert.equal(resolveGroupChatUrl(url, 'true'), url, 'only a real true switches, same as vcpClient');
    assert.throws(() => resolveGroupChatUrl(null, true), TypeError);
    assert.throws(() => resolveGroupChatUrl('not a url', true), TypeError);
});

test('both agent request sites use it; title generation and interrupt select their own routes', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../Groupmodules/groupchat.js'), 'utf8');
    assert.equal(source.match(/fetch\(resolveGroupChatUrl\(globalVcpSettings\.vcpUrl, globalVcpSettings\.enableVcpToolInjection\)/g)?.length, 2);
    assert.equal(source.match(/fetch\(globalVcpSettings\.vcpUrl,/g), null);
    assert.match(source, /enableVcpToolInjection: settings\.enableVcpToolInjection === true/);
    assert.match(source, /vcpServerEndpoint\(globalSettings\.vcpUrl, 'interrupt'\)/);
    const titles = fs.readFileSync(path.resolve(__dirname, '../Groupmodules/topicTitleManager.js'), 'utf8');
    assert.match(titles, /fetch\(vcpChatUrl\(globalVcpSettings\.vcpUrl\),/);
});
