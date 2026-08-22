import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(`Chat contract gate failed: ${message}`); process.exitCode = 1; };
const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/chat-contract.schema.json'), 'utf8'));
const contractsPath = process.env.VCPCHAT_CONTRACTS_INPUT
    ? path.resolve(process.env.VCPCHAT_CONTRACTS_INPUT)
    : path.join(root, 'docs/contracts/chat-contracts.json');
const contracts = JSON.parse(fs.readFileSync(contractsPath, 'utf8'));
if (!Array.isArray(contracts)) fail('docs/contracts/chat-contracts.json must be an array');
const ids = new Set();
for (const contract of contracts) {
    if (!contract || typeof contract !== 'object') { fail('contract entry must be an object'); continue; }
    for (const required of schema.required) if (!(required in contract)) fail(`${contract.id || '<unknown>'} missing ${required}`);
    if (typeof contract.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(contract.id)) fail(`${contract.id || '<unknown>'} has invalid id`);
    if (typeof contract.owner !== 'string' || contract.owner.length === 0) fail(`${contract.id || '<unknown>'} requires a non-empty owner`);
    if (ids.has(contract.id)) fail(`duplicate contract id: ${contract.id}`);
    ids.add(contract.id);
    if (!schema.properties.kind.enum.includes(contract.kind)) fail(`${contract.id} has invalid kind`);
    if (!schema.properties.status.enum.includes(contract.status)) fail(`${contract.id} has invalid status`);
    if (contract.status === 'pass' && Array.isArray(contract.evidence)
        && contract.evidence.some(item => /\b(skipped|manual_required|failed)\b/i.test(String(item)))) {
        fail(`${contract.id} cannot declare pass with skipped/manual_required/failed evidence`);
    }
    if (contract.kind === 'event') {
        if (!Array.isArray(contract.producer) || contract.producer.length === 0) fail(`${contract.id} requires a producer`);
        if (!Array.isArray(contract.consumers) || contract.consumers.length === 0) fail(`${contract.id} requires a consumer`);
        if (!contract.terminal || typeof contract.terminal !== 'object') fail(`${contract.id} requires terminal rules`);
    }
    if (contract.kind === 'facade') {
        if (!Array.isArray(contract.consumers) || contract.consumers.length === 0) fail(`${contract.id} requires registered consumers`);
        if (typeof contract.dynamicSmoke !== 'string' || !contract.dynamicSmoke) fail(`${contract.id} requires dynamic smoke`);
        if (typeof contract.retirement !== 'string' || !contract.retirement) fail(`${contract.id} requires retirement decision`);
    }
    if (contract.kind === 'snapshot') {
        if (typeof contract.snapshot !== 'string' || !contract.snapshot) fail(`${contract.id} requires a snapshot fixture`);
        else if (!fs.existsSync(path.join(root, contract.snapshot))) fail(`${contract.id} snapshot fixture is missing: ${contract.snapshot}`);
        if (typeof contract.sourceEntry !== 'string' || !fs.existsSync(path.join(root, contract.sourceEntry))) fail(`${contract.id} source entry is missing`);
    }
    if (contract.dynamicSites !== undefined) {
        if (contract.kind !== 'event' || contract.dynamic !== true) fail(`${contract.id} dynamicSites requires a dynamic event contract`);
        if (!Array.isArray(contract.dynamicSites) || contract.dynamicSites.length === 0) fail(`${contract.id} dynamicSites must not be empty`);
        for (const site of contract.dynamicSites) {
            if (!site || typeof site.file !== 'string' || !Number.isInteger(site.line) || site.line < 1) {
                fail(`${contract.id} has an invalid dynamicSites entry`);
            } else if (!fs.existsSync(path.join(root, site.file))) {
                fail(`${contract.id} dynamicSites file is missing: ${site.file}`);
            }
        }
    }
}
const generator = process.env.VCPCHAT_GRAPH_INPUT ? null : spawnSync(process.execPath, [path.join(root, 'scripts/build-chat-event-graph.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
if (generator && generator.status !== 0) { fail(generator.stderr || generator.stdout || 'graph generator failed'); }
const graphPath = process.env.VCPCHAT_GRAPH_INPUT
    ? path.resolve(process.env.VCPCHAT_GRAPH_INPUT)
    : path.join(root, 'docs/contracts/generated/chat-event-graph.json');
if (!fs.existsSync(graphPath)) fail('generated chat-event graph is missing');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
if (graph.schemaVersion !== 1 || !Array.isArray(graph.events) || !Array.isArray(graph.registeredDynamic) || !Array.isArray(graph.undiscovered)) fail('generated graph has invalid shape');
if (graph.undiscovered.length) fail(`graph contains ${graph.undiscovered.length} unregistered dynamic event site(s)`);
for (const contract of contracts.filter(item => item.kind === 'event' && item.dynamic === true)) {
    for (const site of contract.dynamicSites || []) {
        if (!graph.registeredDynamic.some(item => item.contractId === contract.id && item.file === site.file && item.line === site.line)) {
            fail(`${contract.id} dynamicSites entry is not observed by the generated graph: ${site.file}:${site.line}`);
        }
    }
}
const consumerReportPath = process.env.VCPCHAT_CONSUMER_REPORT_INPUT
    ? path.resolve(process.env.VCPCHAT_CONSUMER_REPORT_INPUT)
    : path.join(root, 'docs/chat-kernel-consumer-report.json');
if (fs.existsSync(consumerReportPath)) {
    const consumerReport = JSON.parse(fs.readFileSync(consumerReportPath, 'utf8'));
    const facades = consumerReport.ambientFacades || {};
    const facadeContracts = contracts.filter(contract => contract.kind === 'facade');
    for (const contract of facadeContracts) {
        const name = contract.facadeName;
        if (!name || !facades[name]) { fail(`${contract.id} must map to a consumer-report facadeName`); continue; }
        const ledger = facades[name];
        if (ledger.classification !== 'supported-public-facade') fail(`${name} registry entry is not a supported public facade`);
        if (ledger.definitions?.some(definition => definition.file === contract.owner) !== true) fail(`${name} registry owner does not match its definition`);
        if (ledger.production.length === 0) fail(`${name} registry facade has no production evidence`);
    }
    for (const [name, evidence] of Object.entries(facades)) {
        if (!evidence || typeof evidence !== 'object') fail(`facade ${name} has invalid ledger entry`);
        if (evidence.classification === 'supported-public-facade') {
            if (!Array.isArray(evidence.production) || evidence.production.length === 0) fail(`supported facade ${name} has no production consumer`);
            if (!evidence.owner && (!Array.isArray(evidence.definitions) || evidence.definitions.length === 0)) fail(`supported facade ${name} has no owner/definition`);
        }
    }
    const registeredFacadeNames = new Set(facadeContracts.map(contract => contract.facadeName).filter(Boolean));
    for (const [name, evidence] of Object.entries(facades)) {
        if (evidence?.classification === 'supported-public-facade' && !registeredFacadeNames.has(name)) {
            fail(`${name} is a supported public facade but has no registered contract`);
        }
    }
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`Chat contract gate passed (${contracts.length} registered contracts, ${graph.events.length} generated events).`);
