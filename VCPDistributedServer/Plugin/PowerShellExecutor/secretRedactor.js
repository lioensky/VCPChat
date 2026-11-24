'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIN_SECRET_LENGTH = 8;
const REFRESH_TTL_MS = 2000;

const SENSITIVE_KEY_RE = /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|BEARER|COOKIE)/i;
const PATH_LIKE_KEY_RE = /(?:_PATH|_DIR|_DIRECTORY|_FILE|_ROOT|_URL|_HOST|_PORT|_MODE|_MODEL)$/i;
const SAFE_LITERAL_SET = new Set([
    'localhost', '127.0.0.1', '0.0.0.0', '::1', 'true', 'false', 'null', 'none', 'undefined', 'changeme'
]);

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /(\bAuthorization\s*[:=]\s*['"]?Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

function readConfigRedactPaths(configFile) {
    try {
        if (!fs.existsSync(configFile)) return [];
        const text = fs.readFileSync(configFile, 'utf8');
        const m = text.match(/^\s*SECRET_REDACT_PATHS\s*=\s*(.+)$/m);
        if (!m || !m[1]) return [];
        return unquote(m[1]).split(path.delimiter).map((item) => unquote(item)).filter(Boolean);
    } catch {
        return [];
    }
}

function defaultSecretTargets() {
    const configFiles = [
        path.join(__dirname, 'config.env'),
        path.resolve(__dirname, '../MacPowerShell/config.env')
    ];
    const targets = [...configFiles];
    for (const cfg of configFiles) {
        for (const extra of readConfigRedactPaths(cfg)) targets.push(extra);
    }
    if (process.env.VCP_SECRET_REDACT_PATHS) {
        for (const item of process.env.VCP_SECRET_REDACT_PATHS.split(path.delimiter)) {
            if (item.trim()) targets.push(item.trim());
        }
    }
    for (const t of targets) { if (!fs.existsSync(t)) console.warn(`[secretRedactor] target missing: ${t}`); }
    return targets;
}

function shouldSkipSecret(keyName, rawValue) {
    if (typeof rawValue !== 'string') return true;
    const val = rawValue.trim();
    if (val.length < MIN_SECRET_LENGTH) return true;
    if (SAFE_LITERAL_SET.has(val.toLowerCase())) return true;
    if (/^\d+$/.test(val)) return true;
    if (PATH_LIKE_KEY_RE.test(keyName)) return true;
    if (/^[A-Za-z]:[\\/]/.test(val) || val.startsWith('/')) return true;
    if (/^https?:\/\/[^@\s]+$/i.test(val) && !/[?&](?:key|token|secret|sig|password)=/i.test(val)) return true;
    return false;
}

function unquote(raw) {
    const trimmed = raw.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed.replace(/\s+#.*$/, '').trim();
}

function parseEnvContent(text, collector) {
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{1,79})\s*=\s*(.+)$/);
        if (!m) continue;
        const key = m[1];
        const val = unquote(m[2]);
        if (SENSITIVE_KEY_RE.test(key) && !shouldSkipSecret(key, val)) {
            collector.set(val, key.toUpperCase());
        }
    }
}

function parseYamlContent(text, collector) {
    const lines = text.split(/\r?\n/);
    let inKeysBlock = false;
    for (const line of lines) {
        if (/^\s*#/.test(line) || !line.trim()) continue;
        if (/^keys\s*:\s*$/.test(line)) {
            inKeysBlock = true;
            continue;
        }
        if (inKeysBlock) {
            if (/^\S/.test(line)) {
                inKeysBlock = false;
            } else {
                const km = line.match(/^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
                if (km) {
                    const apiKey = unquote(km[1]);
                    const apiSecret = unquote(km[2]);
                    if (!shouldSkipSecret('LIVEKIT_API_KEY', apiKey)) collector.set(apiKey, 'LIVEKIT_API_KEY');
                    if (!shouldSkipSecret('LIVEKIT_API_SECRET', apiSecret)) collector.set(apiSecret, 'LIVEKIT_API_SECRET');
                    continue;
                }
            }
        }
        const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
        if (kv && SENSITIVE_KEY_RE.test(kv[1])) {
            const val = unquote(kv[2]);
            if (!shouldSkipSecret(kv[1], val)) collector.set(val, kv[1].toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
        }
    }
}

function expandFiles(targets) {
    const files = [];
    for (const target of targets) {
        try {
            const st = fs.statSync(target);
            if (st.isFile()) {
                files.push({ filePath: target, mtimeMs: st.mtimeMs });
            } else if (st.isDirectory()) {
                for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
                    if (!entry.isFile()) continue;
                    if (/(\.env|^config\.env$|^server\.ya?ml$)/i.test(entry.name)) {
                        const full = path.join(target, entry.name);
                        const fst = fs.statSync(full);
                        files.push({ filePath: full, mtimeMs: fst.mtimeMs });
                    }
                }
            }
        } catch {
            // 忽略不存在或无权限目录
        }
    }
    return files;
}

function buildReplacementEntries(secretMap) {
    const variantMap = new Map();
    for (const [secret, label] of secretMap.entries()) {
        variantMap.set(secret, `[REDACTED:${label}]`);
        const b64 = Buffer.from(secret, 'utf8').toString('base64');
        if (b64.length >= 12) {
            variantMap.set(b64, `[REDACTED:${label}_B64]`);
            const unpadded = b64.replace(/=+$/, '');
            if (unpadded.length >= 12) variantMap.set(unpadded, `[REDACTED:${label}_B64]`);
        }
        const urlEnc = encodeURIComponent(secret);
        if (urlEnc !== secret && urlEnc.length >= MIN_SECRET_LENGTH) {
            variantMap.set(urlEnc, `[REDACTED:${label}_URL]`);
        }
    }
    return [...variantMap.entries()].sort((a, b) => b[0].length - a[0].length);
}

function createSecretRedactor(customTargets = null) {
    const targets = customTargets || defaultSecretTargets();
    let lastCheckAt = 0;
    let lastSignature = '';
    let cachedEntries = [];

    function refreshIfNeeded(force = false, bypassTtl = false) {
        const now = Date.now();
        if (!force && !bypassTtl && now - lastCheckAt < REFRESH_TTL_MS) return;
        lastCheckAt = now;

        const files = expandFiles(targets);
        const signature = files.map((f) => `${f.filePath}:${f.mtimeMs}`).join('|');
        if (!force && signature === lastSignature) return;
        lastSignature = signature;

        const secretMap = new Map();
        for (const { filePath } of files) {
            try {
                const text = fs.readFileSync(filePath, 'utf8');
                if (/\.ya?ml$/i.test(filePath)) parseYamlContent(text, secretMap);
                else parseEnvContent(text, secretMap);
            } catch {
                // 跳过单文件读取异常
            }
        }
        cachedEntries = buildReplacementEntries(secretMap);
    }

    function redactSecrets(input) {
        if (typeof input !== 'string' || !input) return input;
        refreshIfNeeded(false);
        let out = input;
        for (const [needle, mask] of cachedEntries) {
            if (out.includes(needle)) {
                out = out.split(needle).join(mask);
            }
        }
        out = out.replace(BEARER_RE, '$1[REDACTED:BEARER_TOKEN]');
        out = out.replace(JWT_RE, '[REDACTED:JWT_TOKEN]');
        return out;
    }

    function redactToolResult(result) {
        const copies = new WeakMap();
        const active = new WeakSet();
        function visit(value, depth) {
            if (depth > 8) return '[REDACTED:DEPTH_LIMIT]';
            if (value == null) return value;
            if (typeof value === 'string') return redactSecrets(value);
            if (typeof value === 'number' || typeof value === 'boolean') return value;
            if (typeof value !== 'object') return '[REDACTED:UNSUPPORTED]';
            if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[REDACTED:BINARY]';
            if (active.has(value)) return '[REDACTED:CYCLE]';
            if (copies.has(value)) return copies.get(value);
            const array = Array.isArray(value);
            if (!array && Object.getPrototypeOf(value) !== Object.prototype &&
                Object.getPrototypeOf(value) !== null) return '[REDACTED:UNSUPPORTED]';
            const out = array ? new Array(value.length) : Object.create(null);
            active.add(value);
            for (const key of Object.keys(value)) {
                const prop = Object.getOwnPropertyDescriptor(value, key);
                Object.defineProperty(out, key, {
                    value: prop && 'value' in prop ? visit(prop.value, depth + 1) : '[REDACTED:ACCESSOR]',
                    enumerable: true, configurable: true, writable: true
                });
            }
            active.delete(value);
            copies.set(value, out);
            return out;
        }
        return visit(result, 0);
    }

    return {
        redactSecrets,
        redactToolResult,
        reloadSecrets: () => refreshIfNeeded(true),
        refreshBeforeEgress: () => refreshIfNeeded(false, true)
    };
}

const defaultRedactor = createSecretRedactor();

module.exports = {
    redactSecrets: defaultRedactor.redactSecrets,
    redactToolResult: defaultRedactor.redactToolResult,
    reloadSecrets: defaultRedactor.reloadSecrets,
    refreshBeforeEgress: defaultRedactor.refreshBeforeEgress,
    readConfigRedactPaths,
    createSecretRedactor
};