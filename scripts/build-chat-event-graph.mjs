import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scanChatEventSource } from './chat-event-source.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { describeApis } = createRequire(import.meta.url)('../preloads/core/registry.js');
const defaultSubscriptions = new Set(describeApis().filter(api => api.kind === 'subscription').map(api => api.name));
const sourceRoots = ['main.js', 'renderer.js', 'preloads', 'modules', 'Flowlockmodules', 'VCPDistributedServer'];
const ignored = /(?:^|[\\/])(?:tests?|node_modules|vendor|artifacts|docs)(?:[\\/]|$)/;
const unique = items => [...new Map(items.map(item => [`${item.file}:${item.line}:${item.kind || item.reason}`, item])).values()];

export function buildChatEventGraph({ root = defaultRoot, subscriptionNames = defaultSubscriptions } = {}) {
    const contracts = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/chat-contracts.json'), 'utf8'));
    const dynamicRegistrations = contracts.flatMap(contract => (contract.dynamicSites || []).map(site => ({ ...site, contractId: contract.id })));
    const files = [], nodes = new Map(), registeredDynamic = [], undiscovered = [];
    function walk(relative) {
        const absolute = path.join(root, relative);
        if (!fs.existsSync(absolute)) return;
        if (fs.statSync(absolute).isFile()) {
            if (/\.(?:js|mjs|cjs)$/.test(relative)) files.push(relative.replaceAll('\\', '/'));
            return;
        }
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
            const child = path.join(relative, entry.name).replaceAll('\\', '/');
            if (!ignored.test(child)) walk(child);
        }
    }
    for (const sourceRoot of sourceRoots) walk(sourceRoot);
    for (const file of files.sort()) {
        let scanned;
        try {
            scanned = scanChatEventSource({ file, source: fs.readFileSync(path.join(root, file), 'utf8'), dynamicRegistrations, subscriptionNames });
        } catch (error) {
            throw new Error(`Cannot inventory event source ${file}: ${error.message}`, { cause: error });
        }
        for (const { name, role, match, ...item } of scanned.events) {
            const node = nodes.get(name) || { name, producers: [], consumers: [], evidence: [] };
            node[role].push(item);
            node.evidence.push({ ...item, match });
            nodes.set(name, node);
        }
        registeredDynamic.push(...scanned.registeredDynamic);
        undiscovered.push(...scanned.undiscovered);
    }
    return {
        schemaVersion: 1, sourceRoots, filesScanned: files,
        events: [...nodes.values()].map(node => ({ ...node, producers: unique(node.producers), consumers: unique(node.consumers) })).sort((a, b) => a.name.localeCompare(b.name)),
        registeredDynamic: unique(registeredDynamic), undiscovered: unique(undiscovered)
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const graph = buildChatEventGraph();
    const output = path.join(defaultRoot, 'docs/contracts/generated/chat-event-graph.json');
    const serialized = `${JSON.stringify(graph, null, 2)}\n`;
    if (process.argv.includes('--check')) {
        if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== serialized) {
            console.error('Chat event graph is stale; run npm run build:chat-event-graph and review the diff.');
            process.exitCode = 1;
        }
    } else {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, serialized, 'utf8');
        console.log(`Chat event graph generated (${graph.events.length} events, ${graph.filesScanned.length} files, ${graph.registeredDynamic.length} registered and ${graph.undiscovered.length} undiscovered dynamic sites).`);
    }
}
