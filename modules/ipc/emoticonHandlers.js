// modules/ipc/emoticonHandlers.js

const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');

let emoticonLibrary = [];
let settingsFilePath;
let emoticonLibraryPath;
let degradedReason = null;
let hasWarnedForCurrentReason = false;

function setDegradedState(reason) {
    emoticonLibrary = [];
    if (degradedReason === reason && hasWarnedForCurrentReason) {
        return;
    }

    degradedReason = reason;
    hasWarnedForCurrentReason = true;
    console.warn(`[EmoticonFixer] Emoji library degraded: ${reason}`);
}

function clearDegradedState() {
    degradedReason = null;
    hasWarnedForCurrentReason = false;
}

async function initialize(paths) {
    settingsFilePath = paths.SETTINGS_FILE;
    emoticonLibraryPath = path.join(paths.APP_DATA_ROOT_IN_PROJECT, 'emoticon_library.json');
}

async function generateEmoticonLibrary() {
    console.log('[EmoticonFixer] Starting to generate emoticon library...');

    try {
        const settings = await fs.readJson(settingsFilePath);
        const vcpServerUrl = settings.vcpServerUrl;
        if (!vcpServerUrl) {
            setDegradedState('missing vcpServerUrl in settings.json');
            return [];
        }

        const fileKey = typeof settings.fileKey === 'string' ? settings.fileKey.trim() : '';
        if (!fileKey) {
            setDegradedState('missing fileKey in settings.json');
            return [];
        }

        const urlObject = new URL(vcpServerUrl);
        const baseUrl = `${urlObject.protocol}//${urlObject.host}`;

        const forumConfigPath = path.join(path.dirname(settingsFilePath), 'UserData', 'forum.config.json');
        let authHeader = null;
        if (await fs.pathExists(forumConfigPath)) {
            try {
                const forumConfig = await fs.readJson(forumConfigPath);
                if (forumConfig?.username && forumConfig?.password) {
                    authHeader = `Basic ${Buffer.from(`${forumConfig.username}:${forumConfig.password}`).toString('base64')}`;
                }
            } catch (forumConfigError) {
                console.warn(`[EmoticonFixer] Failed to read forum config for emoji API auth: ${forumConfigError.message}`);
            }
        }

        const response = await fetch(`${baseUrl}/admin_api/emojis/list`, {
            method: 'GET',
            headers: authHeader ? { Authorization: authHeader } : {}
        });

        if (!response.ok) {
            const authHint = response.status === 401 || response.status === 403
                ? ' (admin auth required, please login in Forum page)'
                : '';
            setDegradedState(`failed to fetch emoji list: HTTP ${response.status}${authHint}`);
            return [];
        }

        const payload = await response.json();
        if (!payload?.success || !payload?.data || typeof payload.data !== 'object') {
            setDegradedState('invalid emoji list response payload');
            return [];
        }

        const library = [];
        for (const [category, filenames] of Object.entries(payload.data)) {
            if (!Array.isArray(filenames)) continue;

            for (const rawFilename of filenames) {
                const filename = typeof rawFilename === 'string' ? rawFilename.trim() : '';
                if (!filename) continue;

                const encodedFilename = encodeURIComponent(filename);
                const encodedCategory = encodeURIComponent(category);
                const fullUrl = `${baseUrl}/pw=${fileKey}/images/${encodedCategory}/${encodedFilename}`;

                library.push({
                    url: fullUrl,
                    category,
                    filename,
                    searchKey: `${String(category).toLowerCase()}/${filename.toLowerCase()}`
                });
            }
        }

        await fs.writeJson(emoticonLibraryPath, library, { spaces: 2 });
        emoticonLibrary = library;
        clearDegradedState();
        console.log(`[EmoticonFixer] Successfully generated emoticon library with ${library.length} items.`);
        return library;
    } catch (error) {
        setDegradedState(error.message || 'unexpected generator error');
        return [];
    }
}

function setupEmoticonHandlers() {
    generateEmoticonLibrary();

    ipcMain.handle('get-emoticon-library', async () => {
        if (emoticonLibrary.length > 0) {
            return emoticonLibrary;
        }

        if (await fs.pathExists(emoticonLibraryPath)) {
            try {
                emoticonLibrary = await fs.readJson(emoticonLibraryPath);
                if (Array.isArray(emoticonLibrary) && emoticonLibrary.length > 0) {
                    return emoticonLibrary;
                }
            } catch (error) {
                console.warn(`[EmoticonFixer] Failed to read cache ${emoticonLibraryPath}: ${error.message}`);
            }
        }

        clearDegradedState();
        const generatedLibrary = await generateEmoticonLibrary();
        return Array.isArray(generatedLibrary) ? generatedLibrary : [];
    });

    ipcMain.on('regenerate-emoticon-library', async () => {
        clearDegradedState();
        await generateEmoticonLibrary();
    });
}

module.exports = {
    initialize,
    setupEmoticonHandlers,
    getEmoticonLibrary: () => degradedReason ? [] : emoticonLibrary
};
