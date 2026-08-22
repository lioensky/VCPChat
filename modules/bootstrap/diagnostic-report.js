'use strict';

const fs = require('fs');
const path = require('path');
const { BOOTSTRAP_SCHEMA_VERSION } = require('./contracts');

function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (/key|token|secret|authorization|password/i.test(key)) {
            output[key] = '[redacted]';
        } else if (entry instanceof Error) {
            output[key] = { name: entry.name, message: entry.message, code: entry.code || null };
        } else {
            output[key] = sanitize(entry);
        }
    }
    return output;
}

function writeDiagnosticReport({ stateRoot, operationId, phase, code, message, detail = null, now = new Date() }) {
    const directory = path.join(stateRoot, 'diagnostics');
    fs.mkdirSync(directory, { recursive: true });
    const safeOperationId = String(operationId || 'unknown').replace(/[^a-z0-9_-]/gi, '-');
    const filePath = path.join(directory, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${safeOperationId}.json`);
    const report = sanitize({
        schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
        operationId,
        generatedAt: new Date(now).toISOString(),
        phase,
        code,
        message,
        detail,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
    });
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { path: filePath, report };
}

module.exports = { sanitize, writeDiagnosticReport };
