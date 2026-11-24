'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSecretRedactor, readConfigRedactPaths } = require('./secretRedactor');
const { normalizeAstPayload } = (() => { const m = require('./commandSecurityCheck'); return m; })();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-'));
let fail = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fail++; };
try {
    fs.writeFileSync(path.join(dir, 'a.env'), 'OLD_API_KEY=old' + crypto.randomBytes(8).toString('hex') + '\n');
    const r = createSecretRedactor([dir]);
    r.redactSecrets('prime');                       // 模拟 L813：TTL 窗口开始
    const fresh = 'cnry' + crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(dir, 'b.env'), `FRESH_API_KEY=${fresh}\n`);
    check('without refresh, stale cache (documents old bug)', r.redactSecrets(fresh) === fresh);
    r.refreshBeforeEgress();
    check('plain masked after refreshBeforeEgress', r.redactSecrets(`v=${fresh}`) === 'v=[REDACTED:FRESH_API_KEY]');
    const b64 = Buffer.from(fresh).toString('base64').replace(/=+$/, '');
    check('b64 masked', r.redactSecrets(b64) === '[REDACTED:FRESH_API_KEY_B64]');
    const nested = r.redactToolResult({ content: [{ type: 'text', text: `k=${fresh}` }] });
    check('nested masked', nested.content[0].text === 'k=[REDACTED:FRESH_API_KEY]');
    const shared = { text: fresh };
    const cyclic = { text: fresh };
    cyclic.self = cyclic;
    let deep = fresh;
    for (let i = 0; i < 12; i++) deep = { child: deep };
    const cleaned = r.redactToolResult({ a: shared, b: shared, cyclic, deep,
        binary: Buffer.from(fresh), normal: 'ordinary receipt' });
    const wire = JSON.stringify(cleaned);
    check('serialized aliases masked', cleaned.a === cleaned.b &&
        cleaned.b.text === '[REDACTED:FRESH_API_KEY]' && !wire.includes(fresh));
    check('cycle serializable', cleaned.cyclic.self === '[REDACTED:CYCLE]');
    check('depth bounded', wire.includes('[REDACTED:DEPTH_LIMIT]'));
    check('binary omitted', cleaned.binary === '[REDACTED:BINARY]');
    check('normal text unchanged', cleaned.normal === 'ordinary receipt');
    check('exported on module', typeof require('./secretRedactor').refreshBeforeEgress === 'function');
    const cfgPath = path.join(dir, 'config.env');
    const extraA = path.join(dir, 'extra-a');
    const extraB = path.join(dir, 'extra-b');
    fs.writeFileSync(cfgPath, `SECRET_REDACT_PATHS=${extraA}${path.delimiter}${extraB}\n`);
    const parsedPaths = readConfigRedactPaths(cfgPath);
    check('config.env SECRET_REDACT_PATHS parsed', parsedPaths.length === 2 && parsedPaths[0] === extraA && parsedPaths[1] === extraB);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? `❌ ${fail} failed` : '✅ egress refresh tests passed');
process.exit(fail ? 1 : 0);