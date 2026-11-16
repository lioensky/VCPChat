#!/usr/bin/env node
'use strict';

// stdout belongs exclusively to MCP framing, including during plugin module loading.
const { Console } = require('node:console');
global.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    ListToolsRequestSchema, CallToolRequestSchema,
    ListPromptsRequestSchema, GetPromptRequestSchema,
    ListResourcesRequestSchema, ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { loadConfig, createBridge, INSTRUCTIONS, PROMPT_URI } = require('./bridge.cjs');

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== '--config') throw new Error('Usage: node server.cjs --config <absolute config.json>');
    const config = loadConfig(argv[1]);
    const service = require('../ProjectForgeService');
    const bridge = createBridge(config, service);
    const server = new Server({ name: 'projectforge', version: '1.0.0' }, {
        capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: INSTRUCTIONS,
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async request => bridge.call(request.params.name, request.params.arguments));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'projectforge_development', description: 'ProjectForge 工程调查、批量编辑与验证工作流' }] }));
    server.setRequestHandler(GetPromptRequestSchema, async request => {
        if (request.params.name !== 'projectforge_development') throw new Error('Unknown prompt');
        return { messages: [{ role: 'user', content: { type: 'text', text: bridge.prompt() } }] };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: PROMPT_URI, name: 'ProjectForge development instructions', mimeType: 'text/markdown' }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async request => {
        if (request.params.uri !== PROMPT_URI) throw new Error('Unknown resource');
        return { contents: [{ uri: PROMPT_URI, mimeType: 'text/markdown', text: bridge.prompt() }] };
    });
    let shutdown;
    const stop = () => {
        if (shutdown) return shutdown;
        // Drain admitted operations: terminating early could interrupt a committed write.
        shutdown = (async () => {
            try { await bridge.close(); }
            finally { await server.close(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
        return shutdown;
    };
    server.onclose = stop;
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    try { await server.connect(new StdioServerTransport()); }
    catch (error) { await stop(); throw error; }
}

main().catch(error => { console.error(`[ProjectForge MCP] ${error.stack || error}`); process.exitCode = 1; });
