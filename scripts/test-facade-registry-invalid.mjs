import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-facade-invalid-'));
const contracts = path.join(temp, 'contracts.json');
const original = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/chat-contracts.json'), 'utf8'));
const invalid = original.map(entry => entry.id === 'facade.main-chat-commands'
    ? { ...entry, consumers: [] }
    : entry);
fs.writeFileSync(contracts, `${JSON.stringify(invalid, null, 2)}\n`);
const graph = path.join(root, 'docs/contracts/generated/chat-event-graph.json');
const result = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_CONTRACTS_INPUT: contracts, VCPCHAT_GRAPH_INPUT: graph },
    encoding: 'utf8',
});
assert.notEqual(result.status, 0, 'invalid facade registry unexpectedly passed');
assert.match(`${result.stderr}\n${result.stdout}`, /facade\.main-chat-commands requires registered consumers/);
const report = JSON.parse(fs.readFileSync(path.join(root, 'docs/chat-kernel-consumer-report.json'), 'utf8'));
report.ambientFacades.UnregisteredFacade = {
    classification: 'supported-public-facade',
    definitions: [{ file: 'renderer.js' }],
    production: [{ file: 'renderer.js' }],
};
const reportPath = path.join(temp, 'consumer-report.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const reverse = spawnSync(process.execPath, ['scripts/check-chat-contracts.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_GRAPH_INPUT: graph, VCPCHAT_CONSUMER_REPORT_INPUT: reportPath },
    encoding: 'utf8',
});
assert.notEqual(reverse.status, 0, 'unregistered supported facade unexpectedly passed');
assert.match(`${reverse.stderr}\n${reverse.stdout}`, /UnregisteredFacade.*no registered contract/);
console.log('Facade registry deliberate invalid runner passed (real contract gate rejected missing consumers).');
