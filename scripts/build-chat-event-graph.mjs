import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registeredContracts = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/chat-contracts.json'), 'utf8'));
const dynamicRegistrations = registeredContracts.flatMap(contract =>
    (contract.dynamicSites || []).map(site => ({ ...site, contractId: contract.id }))
);
const sourceRoots = ['main.js', 'renderer.js', 'preloads', 'modules', 'Flowlockmodules', 'VCPDistributedServer'];
const ignored = /(?:^|[\\/])(?:tests?|node_modules|vendor|artifacts|docs)(?:[\\/]|$)/;
const files = [];

function walk(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.statSync(absolute);
    if (stat.isFile()) { if (/\.(?:js|mjs|cjs)$/.test(relative)) files.push(relative.replaceAll('\\', '/')); return; }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = path.join(relative, entry.name).replaceAll('\\', '/');
        if (!ignored.test(child)) walk(child);
    }
}
for (const sourceRoot of sourceRoots) walk(sourceRoot);

const eventPatterns = [
    { kind: 'custom-event-dispatch', regex: /dispatchEvent\(new (?:CustomEvent|CustomEventConstructor)\(['"]([^'"]+)['"]/g },
    { kind: 'custom-event-listener', regex: /(?:addEventListener|on)\(['"]([^'"]+)['"]/g },
    { kind: 'ipc-send', regex: /(?:send|invoke|on|once)\(['"]([^'"]+)['"]/g },
    { kind: 'preload-subscription', regex: /(?:onVCPStreamEvent|onThemeUpdated|on[A-Z][A-Za-z]+)\s*\(/g },
    { kind: 'stream-terminal', regex: /(?:terminal|finish|complete)\s*\(\s*['"](completed|failed|cancelled|aborted|discarded|error)['"]/g }
];
const nodes = new Map();
const undiscovered = [];
const registeredDynamic = [];
const add = (name, role, file, line, kind, evidence) => {
    if (!name || name.length < 2 || /^https?:/.test(name) || /\s/.test(name) || /[\u3400-\u9fff]/.test(name)) return;
    if (!/(?:vcp|chat|stream|theme|history|topic|notification|appearance|flowlock|desktop|message|electron|plugin|surface|terminal|settings|assistant|voice|rust|push|cancel|retry|attachment|window|modal|conversation|selection|preload|ipc|^main\/|^agent\/|^session\/)/i.test(name)
        && !name.includes('/')) return;
    const key = name;
    const node = nodes.get(key) || { name, producers: [], consumers: [], evidence: [] };
    const item = { file, line, kind };
    node[role].push(item);
    node.evidence.push({ ...item, match: evidence });
    nodes.set(key, node);
};

for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const pattern of eventPatterns) {
        for (const match of source.matchAll(pattern.regex)) {
            const offset = match.index ?? 0;
            const line = source.slice(0, offset).split('\n').length;
            const name = match[1] || match[0].replace(/\s+/g, ' ').slice(0, 120);
            const isProducer = pattern.kind.includes('dispatch') || pattern.kind === 'ipc-send' || pattern.kind === 'stream-terminal';
            add(name, isProducer ? 'producers' : 'consumers', file, line, pattern.kind, match[0]);
        }
    }
    for (const match of source.matchAll(/(?:emit|dispatch|send|invoke|on|once)\s*\(\s*eventName\b/g)) {
        undiscovered.push({ file, line: source.slice(0, match.index).split('\n').length, reason: 'dynamic event name' });
    }
    for (const match of source.matchAll(/new (?:CustomEvent|CustomEventConstructor)\(\s*(?!['"])([^,)\s]+)/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        const registration = dynamicRegistrations.find(site => site.file === file && site.line === line);
        const entry = { file, line, reason: `dynamic CustomEvent name: ${match[1]}` };
        if (registration) registeredDynamic.push({ ...entry, contractId: registration.contractId });
        else undiscovered.push(entry);
    }
}

const graph = {
    schemaVersion: 1,
    sourceRoots,
    filesScanned: files.sort(),
    events: [...nodes.values()].map(node => ({
        ...node,
        producers: [...new Map(node.producers.map(item => [`${item.file}:${item.line}:${item.kind}`, item])).values()],
        consumers: [...new Map(node.consumers.map(item => [`${item.file}:${item.line}:${item.kind}`, item])).values()]
    })).sort((a, b) => a.name.localeCompare(b.name)),
    registeredDynamic: [...new Map(registeredDynamic.map(item => [`${item.file}:${item.line}`, item])).values()],
    undiscovered: [...new Map(undiscovered.map(item => [`${item.file}:${item.line}`, item])).values()]
};
const output = path.join(root, 'docs/contracts/generated/chat-event-graph.json');
const serialized = `${JSON.stringify(graph, null, 2)}\n`;
if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== serialized) {
        console.error('Chat event graph is stale; run npm run build:chat-event-graph and review the diff.');
        process.exit(1);
    }
} else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized, 'utf8');
    console.log(`Chat event graph generated (${graph.events.length} events, ${graph.filesScanned.length} files, ${graph.registeredDynamic.length} registered and ${graph.undiscovered.length} undiscovered dynamic sites).`);
}
