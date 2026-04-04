const path = require('path');

const PRELOAD_ROLES = Object.freeze({
    CHAT: 'chat',
    DESKTOP: 'desktop',
    UTILITY: 'utility',
});

function resolvePreloadPathFromBase(basePath, role) {
    return path.join(basePath, 'preloads', `${role}.js`);
}

function resolveProjectPreload(projectRoot, role) {
    return resolvePreloadPathFromBase(projectRoot, role);
}

function resolveAppPreload(appRoot, role) {
    return resolvePreloadPathFromBase(appRoot, role);
}

module.exports = {
    PRELOAD_ROLES,
    resolveProjectPreload,
    resolveAppPreload,
};
