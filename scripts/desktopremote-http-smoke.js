#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_CONFIG_PATH = path.join(PROJECT_ROOT, 'VCPDistributedServer', 'config.env');
const GENERATED_LISTS_CONFIG_PATH = path.join(PROJECT_ROOT, 'AppData', 'generated_lists', 'config.env');
const DEFAULT_HOST = '127.0.0.1';
const TEST_WIDGET_ID = 'desktopremote-http-smoke';
const TEST_WIDGET_MARKER = 'Codex DesktopRemote HTTP Smoke';

function readEnvFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return {};
        return dotenv.parse(fs.readFileSync(filePath));
    } catch (error) {
        throw new Error(`Failed to read ${path.relative(PROJECT_ROOT, filePath)}: ${error.message}`);
    }
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;

        const key = arg.slice(2);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for --${key}`);
        }
        options[key] = value;
        i += 1;
    }
    return options;
}

function resolveConfig(cliOptions) {
    const distConfig = readEnvFile(DIST_CONFIG_PATH);
    const generatedConfig = readEnvFile(GENERATED_LISTS_CONFIG_PATH);

    const port = Number(cliOptions.port || distConfig.DIST_SERVER_PORT);
    if (!port || Number.isNaN(port)) {
        throw new Error('DIST_SERVER_PORT is missing or invalid.');
    }

    const key = cliOptions.key || generatedConfig.file_key;
    if (!key) {
        throw new Error('file_key is missing from AppData/generated_lists/config.env.');
    }

    return {
        host: cliOptions.host || DEFAULT_HOST,
        port,
        key,
    };
}

function postJson({ host, port, key }, payload) {
    const requestBody = JSON.stringify(payload);
    const requestOptions = {
        host,
        port,
        path: `/pw=${encodeURIComponent(key)}/desktop-remote-test`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: 10000,
    };

    return new Promise((resolve, reject) => {
        const req = http.request(requestOptions, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                raw += chunk;
            });
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (error) {
                    return reject(new Error(`Invalid JSON response (${res.statusCode}): ${raw}`));
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${parsed?.error || raw || 'Request failed'}`));
                }

                resolve(parsed);
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('Request timed out.'));
        });

        req.write(requestBody);
        req.end();
    });
}

function extractTextContent(response) {
    const blocks = response?.result?.result?.content;
    if (!Array.isArray(blocks)) return '';
    return blocks
        .filter((item) => item && item.type === 'text')
        .map((item) => item.text || '')
        .join('\n');
}

async function main() {
    const cliOptions = parseArgs(process.argv.slice(2));
    const config = resolveConfig(cliOptions);

    console.log(`[smoke] DesktopRemote HTTP target: http://${config.host}:${config.port}/pw=<key>/desktop-remote-test`);

    const createPayload = {
        command: 'CreateWidget',
        widgetId: TEST_WIDGET_ID,
        htmlContent: `<div style="padding:12px;font-size:18px;">${TEST_WIDGET_MARKER}</div>`,
        x: 180,
        y: 180,
        width: 320,
        height: 140,
    };
    const createResponse = await postJson(config, createPayload);
    if (!createResponse?.success || createResponse?.result?.status !== 'success') {
        throw new Error('CreateWidget did not succeed.');
    }
    const createdWidgetId = createResponse?.result?.result?.content
        ? TEST_WIDGET_ID
        : (createResponse?.commandPayload?.widgetId || TEST_WIDGET_ID);
    console.log(`[smoke] CreateWidget PASS: ${createdWidgetId}`);

    const queryResponse = await postJson(config, { command: 'QueryDesktop' });
    const desktopReport = extractTextContent(queryResponse);
    if (!queryResponse?.success || !desktopReport.includes(TEST_WIDGET_ID)) {
        throw new Error('QueryDesktop did not report the smoke widget.');
    }
    console.log('[smoke] QueryDesktop PASS');

    const sourceResponse = await postJson(config, {
        command: 'ViewWidgetSource',
        widgetId: TEST_WIDGET_ID,
    });
    const widgetSource = extractTextContent(sourceResponse);
    if (!sourceResponse?.success || !widgetSource.includes(TEST_WIDGET_MARKER)) {
        throw new Error('ViewWidgetSource did not include the smoke marker.');
    }
    console.log('[smoke] ViewWidgetSource PASS');

    console.log('[smoke] DesktopRemote HTTP smoke test passed.');
}

main().catch((error) => {
    console.error(`[smoke] FAIL: ${error.message}`);
    process.exit(1);
});
