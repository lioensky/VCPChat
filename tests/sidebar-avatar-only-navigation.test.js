const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('avatar-only sidebar activation switches to the agents tab first', () => {
    const source = fs.readFileSync('modules/event-listeners.js', 'utf8');
    const start = source.indexOf('const setAvatarOnlyMode = (enabled) => {');
    const end = source.indexOf('\n        };', start);
    const implementation = source.slice(start, end);

    assert.notEqual(start, -1, 'setAvatarOnlyMode must exist');
    assert.match(
        implementation,
        /if \(enabled && !document\.getElementById\('tabContentAgents'\)\?\.classList\.contains\('active'\)\) \{\s*uiManager\?\.switchToTab\?\.\('agents'\);\s*\}/
    );
    assert.ok(
        implementation.indexOf("switchToTab?.('agents')") <
            implementation.indexOf('if (enabled && !agentsTabIsActive) return false'),
        'tab navigation must happen before avatar-only activation is validated'
    );
    assert.doesNotMatch(source, /请先切换到助手列表。/);
});