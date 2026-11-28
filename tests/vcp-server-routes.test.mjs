import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeVcpServerUrl, vcpServerEndpoint, vcpChatUrl } from '../modules/utils/vcpServerRoutes.mjs';

const root = 'http://127.0.0.1:5890';
const variants = [root, root + '/', root + '/v1', root + '/v1/chat/completions', root + '/v1/chatvcp/completions/?old=1#old', ' 127.0.0.1:5890 '];

test('global VCP URL is an HTTP origin; legacy paths never leak into unrelated routes', () => {
    for (const input of variants) {
        assert.equal(normalizeVcpServerUrl(input), root);
        assert.equal(vcpChatUrl(input), root + '/v1/chat/completions');
        assert.equal(vcpChatUrl(input, true), root + '/v1/chatvcp/completions');
        assert.equal(vcpChatUrl(input, 'true'), root + '/v1/chat/completions');
        for (const [route, path] of Object.entries({ models: '/v1/models', interrupt: '/v1/interrupt', humanTool: '/v1/human/tool', weather: '/admin_api/weather' })) {
            assert.equal(vcpServerEndpoint(input, route), root + path);
        }
    }
    assert.equal(normalizeVcpServerUrl('https://[::1]:5890/v1'), 'https://[::1]:5890');
});

test('invalid URLs and credentials never become request targets', () => {
    for (const input of [null, '', 'not a url', 'file:///foo', 'ftp://host.invalid', 'http://a:b@host.invalid', 'http://host.invalid:70000', 'https:/host.invalid', '/v1/chat/completions', '//host.invalid']) {
        assert.equal(normalizeVcpServerUrl(input), '');
        assert.throws(() => vcpChatUrl(input), TypeError);
    }
    assert.throws(() => vcpServerEndpoint(root, '//other.test'), /Unknown VCP route/);
});

test('classic settings form normalizes legacy and bare addresses to the same root', () => {
    const realm = { URL };
    realm.window = realm;
    runInNewContext(readFileSync(new URL('../modules/utils/vcpServerRoutes.js', import.meta.url), 'utf8'), realm);
    runInNewContext(readFileSync(new URL('../modules/settingsManager.js', import.meta.url), 'utf8'), realm);
    for (const input of variants) {
        assert.equal(realm.settingsManager.completeVcpUrl(input), root);
        assert.equal(realm.vcpServerRoutes.vcpChatUrl(input, true), vcpChatUrl(input, true));
    }
});