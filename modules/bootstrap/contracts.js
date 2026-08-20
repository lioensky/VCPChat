'use strict';

const BOOTSTRAP_SCHEMA_VERSION = 1;

const ERROR_CODES = Object.freeze({
    PROJECT_INCOMPLETE: 'E_PROJECT_INCOMPLETE',
    NODE_UNSUPPORTED: 'E_NODE_UNSUPPORTED',
    NPM_MISSING: 'E_NPM_MISSING',
    LOCKFILE_INVALID: 'E_LOCKFILE_INVALID',
    DEPENDENCY_MISSING: 'E_DEPENDENCY_MISSING',
    DEPENDENCY_CORRUPT: 'E_DEPENDENCY_CORRUPT',
    NATIVE_ABI_MISMATCH: 'E_NATIVE_ABI_MISMATCH',
    RUST_RUNTIME_MISSING: 'E_RUST_RUNTIME_MISSING',
    RUST_RUNTIME_INVALID: 'E_RUST_RUNTIME_INVALID',
    VENDOR_CLOSURE_INVALID: 'E_VENDOR_CLOSURE_INVALID',
    OPERATION_BUSY: 'E_OPERATION_BUSY',
    OPERATION_STALE_LOCK: 'E_OPERATION_STALE_LOCK',
    ELECTRON_SPAWN: 'E_ELECTRON_SPAWN',
    ELECTRON_CRASH_BEFORE_READY: 'E_ELECTRON_CRASH_BEFORE_READY',
    STARTUP_TIMEOUT: 'E_STARTUP_TIMEOUT',
});

const CHECK_STATUS = Object.freeze({
    PASS: 'pass',
    WARN: 'warn',
    FAIL: 'fail',
    SKIP: 'skip',
});

const BOOTSTRAP_STATES = Object.freeze([
    'idle',
    'acquiring-lock',
    'discovering',
    'validating',
    'ready-to-launch',
    'blocked',
    'launching',
    'awaiting-ready',
    'running',
    'startup-timeout',
    'crashed-before-ready',
    'complete',
]);

module.exports = {
    BOOTSTRAP_SCHEMA_VERSION,
    ERROR_CODES,
    CHECK_STATUS,
    BOOTSTRAP_STATES,
};
