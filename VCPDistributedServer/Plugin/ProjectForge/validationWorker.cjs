'use strict';
// One request/process. Rust owns timeout, cancellation and process-tree cleanup.
// Hashes cover the exact normalized text sent for validation, not encoded file bytes.
const crypto = require('node:crypto');
const path = require('node:path');
// The worker is a native file, but Node dependencies resolve through the archive.
const validatorModule = path.resolve(__dirname, '../../shared/fileKit/validator.js')
    .replace(/([\\/])app\.asar\.unpacked(?=[\\/]|$)/, '$1app.asar');
const { validateCodeStrict, diffDiagnostics, isValidatable } = require(validatorModule);
const MAX_INPUT = 64 * 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function review(request) {
    if (!request || request.protocolVersion !== 1 || typeof request.filePath !== 'string' ||
        request.filePath.length > 4096) throw new Error('Invalid validation envelope');
    for (const key of ['before', 'after']) {
        if (typeof request[key] !== 'string' || Buffer.byteLength(request[key]) > MAX_TEXT ||
            request[key].includes('\r')) throw new Error(`Invalid normalized ${key} text`);
        if (request[`${key}Hash`] !== hash(request[key])) throw new Error(`${key} hash mismatch`);
    }
    const identity = {
        protocolVersion: 1, validatorVersion: 'pf-validation-v1',
        filePath: request.filePath,
        beforeHash: request.beforeHash, afterHash: request.afterHash,
    };
    if (!isValidatable(request.filePath)) return { ...identity, state: 'unsupported' };
    // Sequential per worker: bounded CPU/memory, no illusory Promise.all parallelism.
    const checked = async text => {
        const diagnostics = await validateCodeStrict(request.filePath, text);
        if (!Array.isArray(diagnostics)) throw new Error('Validator returned invalid diagnostics');
        if (diagnostics.some(d => d.ruleId === 'linter-error' ||
            (!d.ruleId && /file ignored|no matching configuration/i.test(d.message || '')))) {
            throw new Error('Validator did not check the requested file');
        }
        return diagnostics;
    };
    const before = await checked(request.before);
    const after = await checked(request.after);
    return {
        ...identity, state: 'completed', before, after,
        introduced: diffDiagnostics(before, after),
    };
}

async function main() {
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_INPUT) throw new Error('Validation input budget exceeded');
        chunks.push(chunk);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    const result = await review(JSON.parse(text));
    const frame = JSON.stringify({ ok: true, result }) + '\n';
    if (Buffer.byteLength(frame) > MAX_OUTPUT) throw new Error('Validation output budget exceeded');
    process.stdout.write(frame);
}
if (require.main === module) main().catch(error => {
    process.stdout.write(JSON.stringify({
        ok: false, error: { code: 'VALIDATION_FAILED', message: String(error.message).slice(0, 2000) },
    }) + '\n');
    process.exitCode = 1;
});
module.exports = { review };