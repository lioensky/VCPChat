'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'vcp-chart';
const SANDBOX_URL = `${SCHEME}://app/Chartmodules/chart-sandbox.html`;
const RESOURCES = new Map([
    ['/Chartmodules/chart-sandbox.html', 'Chartmodules/chart-sandbox.html'],
    ['/Chartmodules/chart-sandbox.js', 'Chartmodules/chart-sandbox.js'],
    ['/vendor/anime.min.js', 'vendor/anime.min.js'],
    ['/vendor/three.min.js', 'vendor/three.min.js'],
    ['/vendor/pixi.min.js', 'vendor/pixi.min.js'],
    ['/vendor/pixi-unsafe-eval.min.js', 'vendor/pixi-unsafe-eval.min.js'],
]);

// Must run before app.whenReady(). No bypassCSP or universal file access.
function registerChartEmbedScheme(protocol) {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: { standard: true, secure: true },
    }]);
}

function resolveChartEmbedResource(rawUrl, projectRoot) {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== `${SCHEME}:` || url.host !== 'app'
            || url.username || url.password || url.search) return null;
        const relative = RESOURCES.get(url.pathname);
        return relative ? path.join(projectRoot, relative) : null;
    } catch {
        return null;
    }
}

async function installChartEmbedProtocol({ protocol, net, projectRoot }) {
    if (protocol.isProtocolHandled && await protocol.isProtocolHandled(SCHEME)) return;
    protocol.handle(SCHEME, request => {
        if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
        const file = resolveChartEmbedResource(request.url, projectRoot);
        if (!file) return new Response('Not Found', { status: 404 });
        return net.fetch(pathToFileURL(file).href);
    });
}

module.exports = {
    SANDBOX_URL,
    registerChartEmbedScheme,
    installChartEmbedProtocol,
    resolveChartEmbedResource,
};